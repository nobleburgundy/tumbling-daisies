#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs             = require('fs');
const path           = require('path');
const readline       = require('readline');
const { execSync }   = require('child_process');

const GIGS_PATH = path.join(__dirname, '../data/gigs.json');
const BIT_PATH  = path.join(__dirname, '../data/bit-status.json');
const ENV_PATH  = path.join(__dirname, '../.env');

const BUFFER_API_KEY    = process.env.BUFFER_API_KEY;
const BUFFER_ORG_ID     = process.env.BUFFER_ORG_ID;
const BUFFER_FB_CHANNEL = process.env.BUFFER_FACEBOOK_CHANNEL_ID;
const BUFFER_IG_CHANNEL = process.env.BUFFER_INSTAGRAM_CHANNEL_ID;
const BUFFER_YT_CHANNEL = process.env.BUFFER_YOUTUBE_CHANNEL_ID;

const DRY_RUN        = process.argv.includes('--dry-run');
const LIST_SHOWS     = process.argv.includes('--list-shows');
const SCHEDULE_POSTS = process.argv.includes('--schedule-posts');
const AUTH           = process.argv.includes('--auth');
const SHOW_HELP      = process.argv.includes('--help') || process.argv.includes('-h');

// ---- color helpers ----

const isTTY = process.stdout.isTTY;
const c = {
  bold:    s => isTTY ? `\x1b[1m${s}\x1b[0m`  : s,
  dim:     s => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
  cyan:    s => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  green:   s => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  yellow:  s => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  blue:    s => isTTY ? `\x1b[34m${s}\x1b[0m` : s,
  magenta: s => isTTY ? `\x1b[35m${s}\x1b[0m` : s,
  red:     s => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
};

// ---- help ----

function printHelp() {
  console.log(`
${c.bold('tumbling-daisies')} — social post scheduler

${c.bold('Usage:')}
  tumbling-daisies [options]

${c.bold('Options:')}
  --auth            One-time Buffer setup (saves API key + channel IDs to .env)
  --list-shows      List upcoming shows with social media status
  --schedule-posts  Launch the interactive post scheduler
  --dry-run         Preview scheduled posts without submitting to Buffer
  --help, -h        Show this help

${c.bold('Environment variables')} ${c.dim('(in .env):')}
  BUFFER_API_KEY               Buffer personal API key ${c.dim('(written by --auth)')}
  BUFFER_ORG_ID                Buffer organization ID ${c.dim('(written by --auth)')}
  BUFFER_FACEBOOK_CHANNEL_ID   Buffer channel ID for Facebook ${c.dim('(written by --auth)')}
  BUFFER_INSTAGRAM_CHANNEL_ID  Buffer channel ID for Instagram ${c.dim('(written by --auth)')}
  BUFFER_YOUTUBE_CHANNEL_ID    Buffer channel ID for YouTube Shorts ${c.dim('(written by --auth)')}

${c.bold('First-time setup:')}
  1. Get your API key from ${c.cyan('publish.buffer.com/settings/api')}
  2. Run ${c.bold('tumbling-daisies --auth')} and paste it in — all other values are saved automatically

${c.dim('--dry-run can be combined with --schedule-posts to preview without posting.')}
`);
}

// ---- env check ----

function checkEnv() {
  const missing = [];
  if (!BUFFER_API_KEY) missing.push('BUFFER_API_KEY');
  if (!BUFFER_ORG_ID)  missing.push('BUFFER_ORG_ID');
  if (missing.length) {
    console.error(c.red('Missing required env vars:') + '\n  ' + missing.join('\n  '));
    console.error(c.dim('\nRun tumbling-daisies --auth to set these up automatically.'));
    process.exit(1);
  }
  if (!BUFFER_FB_CHANNEL && !BUFFER_IG_CHANNEL && !BUFFER_YT_CHANNEL) {
    console.error(c.red('No channels configured.'));
    console.error(c.dim('Run tumbling-daisies --auth and connect at least one platform in Buffer.'));
    process.exit(1);
  }
}

function activeChannels() {
  return [
    BUFFER_FB_CHANNEL && { id: BUFFER_FB_CHANNEL, label: 'Facebook',  service: 'facebook' },
    BUFFER_IG_CHANNEL && { id: BUFFER_IG_CHANNEL, label: 'Instagram', service: 'instagram' },
    BUFFER_YT_CHANNEL && { id: BUFFER_YT_CHANNEL, label: 'YouTube',   service: 'youtube' },
  ].filter(Boolean);
}

function getSiteUrl() {
  try { return 'https://' + fs.readFileSync(path.join(__dirname, '../CNAME'), 'utf8').trim(); }
  catch { return null; }
}

// Tracks promo-videos that have been force-pushed to git this session and are publicly accessible
const pushedToGit = new Set();

function getAssetPublicUrl(filePath) {
  const siteUrl = getSiteUrl();
  if (!siteUrl) return null;
  const rel = path.relative(path.join(__dirname, '..'), filePath);
  // promo-videos are gitignored unless explicitly pushed this session
  if (rel.startsWith('assets/promo-videos') && !pushedToGit.has(filePath)) return null;
  return `${siteUrl}/${rel}`;
}

async function waitForUrl(url, timeoutMs = 180000) {
  process.stdout.write(c.dim('  Waiting for GitHub Pages'));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) { process.stdout.write(' ' + c.green('✓') + '\n'); return true; }
    } catch {}
    process.stdout.write(c.dim('.'));
  }
  process.stdout.write('\n');
  console.log(c.yellow('  ⚠') + c.dim(' Timed out — Buffer may fail to fetch the video. Try again in a minute.'));
  return false;
}

async function pushVideoToGit(filePath) {
  const repoRoot = path.join(__dirname, '..');
  const rel      = path.relative(repoRoot, filePath);
  const sizeMB   = (fs.statSync(filePath).size / 1024 / 1024).toFixed(1);

  if (parseFloat(sizeMB) > 50)
    console.log(c.yellow('  ⚠') + ` Video is ${sizeMB}MB — GitHub warns at 50MB, hard limit is 100MB`);

  console.log(c.dim(`  Pushing ${path.basename(filePath)} (${sizeMB}MB) to GitHub...`));
  try {
    execSync(`git add -f "${rel}"`,                              { cwd: repoRoot, stdio: 'pipe' });
    execSync(`git commit -m "chore: add reel video [skip ci]"`, { cwd: repoRoot, stdio: 'pipe' });
    execSync(`git push`,                                         { cwd: repoRoot, stdio: 'pipe' });
    pushedToGit.add(filePath);
    console.log(`  ${c.green('✓')} Pushed`);
    const publicUrl = getAssetPublicUrl(filePath);
    if (publicUrl) await waitForUrl(publicUrl);
    return true;
  } catch (err) {
    const msg = (err.stderr?.toString() || err.message).trim().split('\n').pop();
    console.error(`  ${c.red('✗')} Push failed: ${msg}`);
    console.error(c.dim('  Attach the video manually in Buffer after scheduling'));
    return false;
  }
}

// ---- gig loading ----

function isPublicGig(gig) {
  if (gig.status !== 'confirmed') return false;
  const v = (gig.venue || '').toLowerCase();
  if (v.includes('recording') || v.includes('rehearsal') || v.includes('practice')) return false;
  return true;
}

function loadUpcomingGigs() {
  const { gigs } = JSON.parse(fs.readFileSync(GIGS_PATH, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  return gigs
    .filter(g => g.date >= today && isPublicGig(g))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---- date formatting ----

function formatDate(dateStr) {
  const d    = new Date(dateStr + 'T12:00:00');
  const day  = d.toLocaleDateString('en-US', { weekday: 'short' });
  const date = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  return `${day} ${date}`;
}

function formatDateLong(dateStr) {
  return new Date(dateStr + 'T12:00:00')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatScheduledAt(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' @ ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function timeAgo(isoStr) {
  const ms    = Date.now() - new Date(isoStr).getTime();
  const mins  = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days > 0)  return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  return `${mins}m ago`;
}

// ---- scheduling ----

function buildScheduledAt(gigDateStr, daysBefore, timeStr) {
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!match) throw new Error(`Could not parse time: "${timeStr}". Use format like "10:00 AM" or "14:00".`);

  let hours      = parseInt(match[1], 10);
  const minutes  = parseInt(match[2], 10);
  const meridiem = (match[3] || '').toLowerCase();
  if (meridiem === 'pm' && hours !== 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  const d = new Date(gigDateStr + 'T12:00:00');
  d.setDate(d.getDate() - daysBefore);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

// ---- Buffer GraphQL client ----

async function graphql(query, variables = {}, apiKey = BUFFER_API_KEY) {
  const res = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json.errors) throw new Error(json.errors.map(e => e.message).join(', '));
  return json.data;
}

// ---- Buffer API ----

async function postToBuffer(text, scheduledAt, mediaPath, postType, thumbnailPath = null) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id } }
        ... on MutationError { message }
      }
    }
  `;

  // Build asset entry from a public URL if the file is served by the site
  let assetEntry = null;
  const mediaIsLocal = mediaPath && !getAssetPublicUrl(mediaPath);
  if (mediaPath) {
    const publicUrl = getAssetPublicUrl(mediaPath);
    if (publicUrl) {
      const isVideo = VIDEO_EXTS.includes(path.extname(mediaPath).toLowerCase());
      const thumbUrl = thumbnailPath ? getAssetPublicUrl(thumbnailPath) : null;
      assetEntry = isVideo
        ? { video: { url: publicUrl, ...(thumbUrl ? { thumbnailUrl: thumbUrl } : {}) } }
        : { image: { url: publicUrl } };
    }
  }

  if (mediaIsLocal) {
    console.log(c.yellow('  ⚠') + c.dim(` ${path.basename(mediaPath)} is not publicly accessible — attach it manually in Buffer`));
  }

  for (const { id: channelId, label, service } of activeChannels()) {
    let metadata;
    if (service === 'instagram' && postType) {
      metadata = { instagram: { type: postType, shouldShareToFeed: postType !== 'story' } };
    } else if (service === 'facebook' && postType) {
      const fbType = postType === 'reel' ? 'reel' : postType === 'story' ? 'story' : 'post';
      metadata = { facebook: { type: fbType } };
    }

    const input = {
      text,
      channelId,
      schedulingType: 'automatic',
      mode: 'customScheduled',
      dueAt: scheduledAt,
      assets: assetEntry ? [assetEntry] : [],
      ...(metadata ? { metadata } : {}),
    };
    const data   = await graphql(mutation, { input });
    const result = data.createPost;
    if (result.message) throw new Error(`${label}: ${result.message}`);
  }
}

// ---- Buffer status fetch ----

async function fetchScheduledPosts(channelId) {
  try {
    const data = await graphql(`
      query {
        posts(
          first: 100
          input: {
            organizationId: "${BUFFER_ORG_ID}"
            filter: { status: [scheduled], channelIds: ["${channelId}"] }
            sort: [{ field: dueAt, direction: asc }]
          }
        ) {
          edges { node { id text dueAt } }
        }
      }
    `);
    return data.posts.edges.map(e => e.node);
  } catch {
    return null;
  }
}

function matchPostsToGig(posts, gig) {
  if (!posts) return null;
  const needle = (gig.eventName || gig.venue).toLowerCase();
  return posts.filter(p => p.text && p.text.toLowerCase().includes(needle));
}

function renderSocialLine(label, colorFn, matches) {
  const tag = colorFn(`${label}:`.padEnd(12));
  if (matches === null)     return `    ${tag} ${c.dim('(API unavailable)')}`;
  if (matches.length === 0) return `    ${tag} ${c.dim('not scheduled')}`;
  const count = c.green(`${matches.length} scheduled`);
  const dates = c.dim(matches.map(p => formatScheduledAt(p.dueAt)).join(', '));
  return `    ${tag} ${count}  ${dates}`;
}

// ---- CLI helpers ----

function rl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface, question) {
  return new Promise(resolve => iface.question(question, resolve));
}

function askPrefilled(iface, question, defaultValue) {
  return new Promise(resolve => {
    iface.question(question, resolve);
    iface.write(defaultValue);
  });
}

function printGigList(gigs) {
  console.log(c.dim('\nUpcoming public gigs:\n'));
  gigs.forEach((g, i) => {
    const name = g.eventName || g.venue;
    const time = g.showtime ? c.dim(`  ${g.showtime}`) : '';
    console.log(`  ${c.dim(`[${i + 1}]`)} ${c.cyan(formatDate(g.date))}  ${c.bold(name)}${time}`);
  });
}

function parseSelection(input, max) {
  if (input.trim().toLowerCase() === 'all') {
    return Array.from({ length: max }, (_, i) => i);
  }
  return input
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const n = parseInt(s, 10);
      if (isNaN(n) || n < 1 || n > max) throw new Error(`Invalid selection: "${s}"`);
      return n - 1;
    });
}

// ---- .env writer ----

function updateEnvFile(key, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch { /* new file */ }
  const line  = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content + (content.endsWith('\n') || content === '' ? '' : '\n') + line + '\n';
  }
  fs.writeFileSync(ENV_PATH, content);
}

// ---- auth ----

async function runAuth() {
  console.log(c.bold('\nBuffer Setup\n'));
  console.log(`Get your API key from: ${c.cyan('https://publish.buffer.com/settings/api')}\n`);

  const iface  = rl();
  const apiKey = (await ask(iface, 'Paste your Buffer API key: ')).trim();
  iface.close();

  if (!apiKey) { console.error(c.red('No API key provided.')); process.exit(1); }

  process.stdout.write('Fetching account info... ');
  const accountData = await graphql(`
    query {
      account {
        name
        organizations { id name }
      }
    }
  `, {}, apiKey);
  console.log(c.green('done'));

  const org = accountData.account.organizations[0];
  console.log(c.dim(`  Account: ${accountData.account.name}`));
  console.log(c.dim(`  Organization: ${org.name}`));

  process.stdout.write('Fetching channels... ');
  const channelsData = await graphql(`
    query {
      channels(input: { organizationId: "${org.id}" }) {
        id name service
      }
    }
  `, {}, apiKey);
  console.log(c.green('done'));

  updateEnvFile('BUFFER_API_KEY', apiKey);
  updateEnvFile('BUFFER_ORG_ID', org.id);
  console.log('\n' + c.green('✓') + ' BUFFER_API_KEY saved');
  console.log(c.green('✓') + ' BUFFER_ORG_ID saved\n');

  const serviceMap = {
    facebook:  'BUFFER_FACEBOOK_CHANNEL_ID',
    instagram: 'BUFFER_INSTAGRAM_CHANNEL_ID',
    youtube:   'BUFFER_YOUTUBE_CHANNEL_ID',
  };
  const found = [], missing = [];
  for (const [service, envKey] of Object.entries(serviceMap)) {
    const channel = channelsData.channels.find(ch => ch.service === service);
    if (channel) {
      updateEnvFile(envKey, channel.id);
      found.push(`${c.green('✓')} ${envKey} ${c.dim(`(${channel.name})`)}`);
    } else {
      missing.push(`${c.dim('–')} ${envKey} ${c.dim(`(no ${service} channel found in Buffer)`)}`);
    }
  }

  console.log([...found, ...missing].join('\n'));
  if (missing.length) {
    console.log(c.dim('\nConnect the missing platforms in Buffer, then re-run --auth.'));
  } else {
    console.log(c.dim('\nAll set. Run tumbling-daisies --list-shows to verify.'));
  }
}

// ---- list shows ----

async function listShows(gigs) {
  if (gigs.length === 0) {
    console.log('No upcoming confirmed public gigs found in data/gigs.json.');
    return;
  }

  const bitData      = JSON.parse(fs.readFileSync(BIT_PATH, 'utf8'));
  const bitPublished = new Set(bitData.published.map(e => e.date));

  const hasBuffer = BUFFER_API_KEY && BUFFER_ORG_ID && (BUFFER_FB_CHANNEL || BUFFER_IG_CHANNEL || BUFFER_YT_CHANNEL);
  let fbPosts = null, igPosts = null, ytPosts = null;
  if (hasBuffer) {
    process.stdout.write(c.dim('Fetching Buffer status...'));
    [fbPosts, igPosts, ytPosts] = await Promise.all([
      BUFFER_FB_CHANNEL ? fetchScheduledPosts(BUFFER_FB_CHANNEL) : Promise.resolve(null),
      BUFFER_IG_CHANNEL ? fetchScheduledPosts(BUFFER_IG_CHANNEL) : Promise.resolve(null),
      BUFFER_YT_CHANNEL ? fetchScheduledPosts(BUFFER_YT_CHANNEL) : Promise.resolve(null),
    ]);
    process.stdout.write('\r' + ' '.repeat(30) + '\r');
  }

  const showWord = gigs.length === 1 ? 'show' : 'shows';
  console.log(c.dim(`\n${gigs.length} upcoming ${showWord}  ·  Bandsintown updated ${timeAgo(bitData.fetchedAt)}\n`));

  for (const g of gigs) {
    const name = g.eventName || g.venue;
    console.log(`  ${c.cyan(formatDate(g.date))}  ${c.bold(name)}`);

    const detail = (label, value, colorFn = s => s) => {
      if (!value) return;
      console.log(`    ${c.dim((label + ':').padEnd(10))} ${colorFn(value)}`);
    };
    detail('Time',     g.showtime,   c.cyan);
    detail('Location', g.location);
    detail('Cover',    g.cover,      c.green);
    detail('Tickets',  g.ticketLink);
    detail('Lineup',   g.lineup);
    detail('Ages',     g.age);

    const bitTag = c.dim('Bandsintown:'.padEnd(12));
    console.log(bitPublished.has(g.date)
      ? `    ${bitTag} ${c.green('published')}`
      : `    ${bitTag} ${c.dim('not published')}`
    );

    if (hasBuffer) {
      if (BUFFER_FB_CHANNEL) console.log(renderSocialLine('Facebook',  c.blue,    matchPostsToGig(fbPosts, g)));
      if (BUFFER_IG_CHANNEL) console.log(renderSocialLine('Instagram', c.magenta, matchPostsToGig(igPosts, g)));
      if (BUFFER_YT_CHANNEL) console.log(renderSocialLine('YouTube',   c.red,     matchPostsToGig(ytPosts, g)));
    }
    console.log();
  }
}

// ---- media helpers ----

const ASSETS_DIR       = path.join(__dirname, '../assets');
const PROMO_VIDEOS_DIR = path.join(__dirname, '../assets/promo-videos');
const VIDEO_EXTS       = ['.mp4', '.mov', '.m4v'];
const BACK             = '__back__';
const IMAGE_EXTS       = ['.jpg', '.jpeg', '.png', '.heic'];

// Instagram dimension specs per post type
const SPECS = {
  post:  { minRatio: 0.8, maxRatio: 1.91, optimalW: 1080, optimalH: 1350, label: 'Feed Post' },
  story: { targetRatio: 9 / 16, optimalW: 1080, optimalH: 1920, label: 'Story' },
  reel:  { targetRatio: 9 / 16, optimalW: 1080, optimalH: 1920, label: 'Reel' },
};


function getImageDimensions(filePath) {
  try {
    const out = execSync(`sips -g pixelWidth -g pixelHeight "${filePath}" 2>/dev/null`).toString();
    const w = parseInt(out.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const h = parseInt(out.match(/pixelHeight:\s*(\d+)/)?.[1]);
    return (w && h) ? { width: w, height: h } : null;
  } catch { return null; }
}

function getVideoDimensions(filePath) {
  try {
    const out = execSync(`ffprobe -v quiet -print_format json -show_streams "${filePath}" 2>/dev/null`).toString();
    const video = JSON.parse(out).streams?.find(s => s.codec_type === 'video');
    return video ? { width: video.width, height: video.height } : null;
  } catch { return null; }
}

function checkMedia(filePath, postType) {
  const ext     = path.extname(filePath).toLowerCase();
  const isVideo = VIDEO_EXTS.includes(ext);
  const isImage = IMAGE_EXTS.includes(ext);
  const spec    = SPECS[postType];
  const warnings = [], errors = [];

  if (postType === 'reel') {
    if (!isVideo) { errors.push('Reels require a video file (.mp4 or .mov)'); return { warnings, errors }; }
    const dims = getVideoDimensions(filePath);
    if (!dims) {
      warnings.push('Could not verify video dimensions — install ffprobe for validation');
    } else {
      const ratio = dims.width / dims.height;
      if (Math.abs(ratio - spec.targetRatio) > 0.05)
        warnings.push(`Video is ${dims.width}×${dims.height} — Reels expect 9:16 (${spec.optimalW}×${spec.optimalH})`);
      if (dims.width < spec.optimalW)
        warnings.push(`Video width ${dims.width}px is below the recommended ${spec.optimalW}px`);
    }
    return { warnings, errors };
  }

  if (!isImage) {
    if (postType === 'story' && isVideo) {
      const dims = getVideoDimensions(filePath);
      if (dims && Math.abs(dims.width / dims.height - spec.targetRatio) > 0.05)
        warnings.push(`Video is ${dims.width}×${dims.height} — Stories expect 9:16 (${spec.optimalW}×${spec.optimalH})`);
      return { warnings, errors };
    }
    errors.push('Expected an image file (.jpg, .jpeg, .png)');
    return { warnings, errors };
  }

  const dims = getImageDimensions(filePath);
  if (!dims) { warnings.push('Could not read image dimensions'); return { warnings, errors }; }

  const { width, height } = dims;
  const ratio = width / height;

  if (postType === 'story') {
    if (Math.abs(ratio - spec.targetRatio) > 0.05)
      warnings.push(`Image is ${width}×${height} — Stories expect 9:16 (${spec.optimalW}×${spec.optimalH})`);
    if (width < spec.optimalW)
      warnings.push(`Width ${width}px is below the recommended ${spec.optimalW}px`);
  } else {
    if (ratio < spec.minRatio)
      errors.push(`Image ratio ${width}×${height} is too tall — feed posts require at most 4:5 portrait`);
    else if (ratio > spec.maxRatio)
      errors.push(`Image ratio ${width}×${height} is too wide — feed posts require at most 1.91:1 landscape`);
    if (width < spec.optimalW)
      warnings.push(`Width ${width}px is below the recommended ${spec.optimalW}px`);
    if (!errors.length && Math.abs(ratio - 4 / 5) > 0.1)
      warnings.push(`Image is ${width}×${height} — 1080×1350 (4:5 portrait) gets the best feed visibility`);
  }

  return { warnings, errors };
}

// ---- interactive crop tool (browser-based, no Python/Tk dependency) ----

function getCropTarget(filePath, postType) {
  if (postType === 'story' || postType === 'reel') return { w: 9, h: 16 };
  const dims = getImageDimensions(filePath);
  if (!dims) return null;
  const ratio = dims.width / dims.height;
  if (ratio < SPECS.post.minRatio) return { w: 4, h: 5 };     // too tall → 4:5 portrait
  if (ratio > SPECS.post.maxRatio) return { w: 191, h: 100 };  // too wide → 1.91:1
  return null;
}

function buildCropHtml(cropW, cropH) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Crop Image — ${cropW}:${cropH}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; color: #ccc; font-family: -apple-system, sans-serif;
         display: flex; flex-direction: column; align-items: center; min-height: 100vh; }
  #info { padding: 10px 16px; font-size: 13px; color: #777; text-align: center; }
  #wrap { position: relative; }
  canvas { display: block; cursor: move; }
  #btns { padding: 12px 0; display: flex; gap: 10px; }
  button { padding: 8px 22px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
  #apply  { background: #2a7d46; color: #fff; }
  #apply:hover { background: #35a05a; }
  #cancel { background: #333; color: #ccc; }
  #cancel:hover { background: #444; }
  #done { display: none; padding: 60px 40px; font-size: 18px; }
</style>
</head>
<body>
<div id="info">Loading…</div>
<canvas id="c"></canvas>
<div id="btns">
  <button id="apply">Apply Crop</button>
  <button id="cancel">Cancel</button>
</div>
<div id="done"></div>
<script>
const RATIO_W = ${cropW}, RATIO_H = ${cropH};
const TARGET  = RATIO_W / RATIO_H;
const canvas  = document.getElementById('c');
const ctx     = canvas.getContext('2d');
const img     = new Image();

img.onload = () => {
  const maxW = Math.min(window.innerWidth  - 40, 960);
  const maxH = Math.min(window.innerHeight - 130, 760);
  const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  canvas.width  = Math.round(img.naturalWidth  * scale);
  canvas.height = Math.round(img.naturalHeight * scale);

  let crop = { x: 0, y: 0, w: 0, h: 0 };
  if (img.naturalWidth / img.naturalHeight > TARGET) {
    crop.h = canvas.height;
    crop.w = Math.round(canvas.height * TARGET);
    crop.x = (canvas.width - crop.w) / 2;
  } else {
    crop.w = canvas.width;
    crop.h = Math.round(canvas.width / TARGET);
    crop.y = (canvas.height - crop.h) / 2;
  }

  document.getElementById('info').textContent =
    'Original: ' + img.naturalWidth + '\\u00d7' + img.naturalHeight +
    '  \\u2192  Target ratio: ' + RATIO_W + ':' + RATIO_H +
    '  \\u00b7  Drag to reposition';

  let drag = null;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0,        0,        canvas.width,  crop.y);
    ctx.fillRect(0,        crop.y + crop.h, canvas.width, canvas.height - crop.y - crop.h);
    ctx.fillRect(0,        crop.y,   crop.x,        crop.h);
    ctx.fillRect(crop.x + crop.w, crop.y, canvas.width - crop.x - crop.w, crop.h);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(crop.x + 1, crop.y + 1, crop.w - 2, crop.h - 2);
    // Rule-of-thirds guides
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(crop.x + crop.w * i / 3, crop.y);
      ctx.lineTo(crop.x + crop.w * i / 3, crop.y + crop.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(crop.x, crop.y + crop.h * i / 3);
      ctx.lineTo(crop.x + crop.w, crop.y + crop.h * i / 3); ctx.stroke();
    }
    // Corner handles
    ctx.fillStyle = '#fff';
    const hs = 8;
    [[crop.x, crop.y], [crop.x + crop.w - hs, crop.y],
     [crop.x, crop.y + crop.h - hs], [crop.x + crop.w - hs, crop.y + crop.h - hs]]
      .forEach(([x, y]) => ctx.fillRect(x, y, hs, hs));
  }

  draw();

  canvas.addEventListener('mousedown', e => {
    const r = canvas.getBoundingClientRect();
    drag = { ox: e.clientX - r.left - crop.x, oy: e.clientY - r.top - crop.y };
  });
  canvas.addEventListener('mousemove', e => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    crop.x = Math.max(0, Math.min(canvas.width  - crop.w, e.clientX - r.left - drag.ox));
    crop.y = Math.max(0, Math.min(canvas.height - crop.h, e.clientY - r.top  - drag.oy));
    draw();
  });
  canvas.addEventListener('mouseup',    () => drag = null);
  canvas.addEventListener('mouseleave', () => drag = null);

  function applyCrop() {
    const ox = Math.round(crop.x / scale);
    const oy = Math.round(crop.y / scale);
    const ow = Math.round(crop.w / scale);
    const oh = Math.round(crop.h / scale);
    fetch('/crop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: ox, y: oy, w: ow, h: oh })
    }).then(() => {
      document.getElementById('btns').style.display = 'none';
      canvas.style.display = 'none';
      const d = document.getElementById('done');
      d.style.display = 'block';
      d.style.color = '#2a7d46';
      d.textContent = '\\u2713 Crop applied. You can close this tab.';
    });
  }

  document.getElementById('apply').addEventListener('click', applyCrop);
  document.getElementById('cancel').addEventListener('click', () => {
    fetch('/cancel', { method: 'POST' }).then(() => {
      document.getElementById('btns').style.display = 'none';
      canvas.style.display = 'none';
      const d = document.getElementById('done');
      d.style.display = 'block';
      d.style.color = '#777';
      d.textContent = 'Cancelled. You can close this tab.';
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter')  applyCrop();
  });
};

img.src = '/image';
</script>
</body>
</html>`;
}

async function cropImage(filePath, cropW, cropH) {
  const http    = require('http');
  const ext     = path.extname(filePath);
  const outPath = path.join(path.dirname(filePath), `${path.basename(filePath, ext)}-cropped${ext}`);
  const imgBuf  = fs.readFileSync(filePath);
  const mime    = ['.jpg', '.jpeg'].includes(ext.toLowerCase()) ? 'image/jpeg' : 'image/png';
  const html    = buildCropHtml(cropW, cropH);
  const dims    = getImageDimensions(filePath) || {};

  return new Promise(resolve => {
    const server = require('http').createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (req.method === 'GET' && req.url === '/image') {
        res.writeHead(200, { 'Content-Type': mime });
        res.end(imgBuf);
      } else if (req.method === 'POST' && req.url === '/crop') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          res.writeHead(200); res.end('ok');
          server.close();
          try {
            const { x, y, w, h } = JSON.parse(body);
            // sips --cropOffset Y is from the bottom-left of the image
            const offsetY = Math.max(0, (dims.height || h) - y - h);
            execSync(`sips -c ${h} ${w} --cropOffset ${offsetY} ${x} "${filePath}" --out "${outPath}"`,
                     { stdio: 'pipe' });
            console.log(`\n  ${c.green('✓')} Saved: ${c.dim(path.basename(outPath))}`);
            resolve(outPath);
          } catch (err) {
            console.error(`\n  ${c.red('✗')} Crop failed: ${err.message}`);
            resolve(null);
          }
        });
      } else if (req.method === 'POST' && req.url === '/cancel') {
        res.writeHead(200); res.end('ok');
        server.close();
        resolve(null);
      } else {
        res.writeHead(404); res.end();
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log(c.dim('  Opening crop tool in browser...'));
      execSync(`open "http://127.0.0.1:${port}"`);
    });
  });
}

function listAssets(postType) {
  if (postType === 'reel') {
    try {
      return fs.readdirSync(PROMO_VIDEOS_DIR)
        .filter(f => VIDEO_EXTS.includes(path.extname(f).toLowerCase()))
        .map(f => path.join(PROMO_VIDEOS_DIR, f));
    } catch { return []; }
  }
  try {
    return fs.readdirSync(ASSETS_DIR)
      .filter(f => /^(press|ig|social|fb|yt)-/i.test(f) && IMAGE_EXTS.includes(path.extname(f).toLowerCase()) && !f.includes('thumb'))
      .map(f => path.join(ASSETS_DIR, f));
  } catch { return []; }
}

function openFilePicker(postType) {
  const isVideo  = postType === 'reel';
  const types    = isVideo ? '{"public.movie"}' : '{"public.image"}';
  const prompt   = isVideo ? 'Select a video for your Reel:' : 'Select an image:';
  try {
    return execSync(`osascript -e 'POSIX path of (choose file with prompt "${prompt}" of type ${types})'`).toString().trim() || null;
  } catch { return null; } // user cancelled
}

// ---- reel composer (image + audio → mp4) ----

const MUSIC_DIR = path.join(__dirname, '../assets/music');
const AUDIO_EXTS = ['.mp3', '.m4a', '.aac', '.wav'];

function hasFFmpeg() {
  try { execSync('ffmpeg -version', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function listMusicFiles() {
  // Try music.json for display names, fall back to raw listing
  try {
    const tracks = JSON.parse(fs.readFileSync(path.join(__dirname, '../music.json'), 'utf8')).tracks || [];
    return tracks
      .map(t => ({ filePath: path.join(MUSIC_DIR, t.filename), label: [t.title, t.artist].filter(Boolean).join(' — ') || t.filename }))
      .filter(t => fs.existsSync(t.filePath));
  } catch {
    try {
      return fs.readdirSync(MUSIC_DIR)
        .filter(f => AUDIO_EXTS.includes(path.extname(f).toLowerCase()))
        .map(f => ({ filePath: path.join(MUSIC_DIR, f), label: f }));
    } catch { return []; }
  }
}

function openAudioFilePicker() {
  try {
    return execSync(`osascript -e 'POSIX path of (choose file with prompt "Select an audio file:" of type {"public.audio", "public.mp3"})'`).toString().trim() || null;
  } catch { return null; }
}

async function promptMp3(iface) {
  const tracks = listMusicFiles();
  console.log(c.dim('\n  Audio:'));
  if (tracks.length > 0) {
    console.log(`    ${c.dim('[1]')} Choose from music library`);
    console.log(`    ${c.dim('[2]')} Choose file`);
  } else {
    console.log(`    ${c.dim('[1]')} Choose file`);
  }

  while (true) {
    const choice = (await ask(iface, '  > ')).trim();
    if (tracks.length > 0) {
      if (choice === '1') {
        console.log();
        tracks.forEach((t, i) => console.log(`    ${c.dim(`[${i + 1}]`)} ${t.label}`));
        const sel = (await ask(iface, '\n  > ')).trim();
        const n = parseInt(sel, 10);
        if (n >= 1 && n <= tracks.length) return tracks[n - 1].filePath;
        console.error('  Invalid selection.'); continue;
      }
      if (choice === '2') {
        console.log(c.dim('  Opening file picker...'));
        const p = openAudioFilePicker();
        if (p) return p;
        console.log(c.dim('  No file selected.')); continue;
      }
    } else {
      if (choice === '1') {
        console.log(c.dim('  Opening file picker...'));
        const p = openAudioFilePicker();
        if (p) return p;
        console.log(c.dim('  No file selected.')); continue;
      }
    }
    console.error('  Enter 1 or 2.');
  }
}

async function promptImageForReel(iface) {
  const files = listAssets('post'); // all press/ig/social/fb/yt images
  console.log(c.dim('\n  Background image:'));
  console.log(`    ${c.dim('[1]')} Choose from assets folder`);
  console.log(`    ${c.dim('[2]')} Choose file`);

  while (true) {
    const choice = (await ask(iface, '  > ')).trim();
    if (choice === '1') {
      if (!files.length) { console.log(c.dim('  No images found.')); continue; }
      console.log();
      files.forEach((f, i) => {
        const dims = getImageDimensions(f);
        console.log(`    ${c.dim(`[${i + 1}]`)} ${path.basename(f)}${dims ? c.dim(` ${dims.width}×${dims.height}`) : ''}`);
      });
      const sel = (await ask(iface, '\n  > ')).trim();
      const n = parseInt(sel, 10);
      if (n >= 1 && n <= files.length) return files[n - 1];
      console.error('  Invalid selection.'); continue;
    }
    if (choice === '2') {
      console.log(c.dim('  Opening file picker...'));
      const p = openFilePicker('post');
      if (p) return p;
      console.log(c.dim('  No file selected.')); continue;
    }
    console.error('  Enter 1 or 2.');
  }
}

function buildTrimHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Trim Audio</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; color: #ccc; font-family: -apple-system, sans-serif;
         display: flex; flex-direction: column; align-items: center; padding: 24px 20px; }
  #info { font-size: 13px; color: #666; margin-bottom: 14px; text-align: center; line-height: 1.6; }
  #canvas-wrap { width: 900px; max-width: calc(100vw - 40px); }
  canvas { display: block; border-radius: 4px; background: #1a1a1a; }
  #controls { display: flex; align-items: center; gap: 14px; margin: 10px 0; flex-wrap: wrap; }
  button { padding: 7px 18px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; }
  #playbtn { background: #2a3a4a; color: #ccc; }
  #playbtn:hover { background: #354555; }
  #timedisp { font-size: 12px; color: #666; font-family: monospace; }
  #selbadge { font-size: 12px; color: #2a9d5c; font-family: monospace; }
  #btns { display: flex; gap: 10px; margin-top: 14px; }
  #apply { background: #2a7d46; color: #fff; }
  #apply:hover { background: #35a05a; }
  #cancel { background: #333; color: #ccc; }
  #reselect { background: transparent; color: #555; font-size: 12px; text-decoration: underline; padding: 4px 8px; }
  #reselect:hover { color: #888; }
  #done { display: none; padding: 60px 40px; font-size: 18px; text-align: center; }
</style>
</head>
<body>
<div id="info">Loading audio…</div>
<div id="canvas-wrap"><canvas id="c" height="130"></canvas></div>
<div id="controls">
  <button id="playbtn">▶ Play selection</button>
  <span id="timedisp">—</span>
  <span id="selbadge"></span>
</div>
<div id="btns">
  <button id="apply">Apply Trim</button>
  <button id="cancel">Cancel (use full audio)</button>
  <button id="reselect">Select Different Audio File</button>
</div>
<div id="done"></div>
<script>
const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');
let W = 0;

function resize() {
  W = canvas.parentElement.offsetWidth;
  canvas.width = W;
  drawWaveform();
}
window.addEventListener('resize', resize);

let audioBuffer = null, peaks = null;
let playSource = null, playStartAcTime = 0, playStartSec = 0, isPlaying = false;
const ac = new AudioContext();
let trim = { start: 0, end: 1 };
let drag = null, dragOff = 0;

function fmt(s) {
  const m   = Math.floor(s / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  const ms  = String(Math.round((s % 1) * 10));
  return m + ':' + sec + '.' + ms;
}

function buildPeaks(buf, n) {
  const data = buf.getChannelData(0);
  const step = data.length / n;
  const out  = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let mx = 0;
    const base = Math.floor(i * step);
    const end  = Math.min(data.length, base + Math.ceil(step));
    for (let j = base; j < end; j++) {
      const v = Math.abs(data[j] || 0);
      if (v > mx) mx = v;
    }
    out[i] = mx;
  }
  return out;
}

function drawWaveform() {
  if (!W) return;
  const H = canvas.height, mid = H / 2;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, W, H);
  if (!peaks) return;

  const sx = trim.start * W, ex = trim.end * W;

  ctx.fillStyle = 'rgba(42,125,70,0.12)';
  ctx.fillRect(sx, 0, ex - sx, H);

  for (let i = 0; i < W; i++) {
    const idx = Math.floor(i * peaks.length / W);
    const h   = peaks[idx] * (H - 28) * 0.9;
    ctx.fillStyle = (i >= sx && i <= ex) ? '#2a7d46' : '#383838';
    ctx.fillRect(i, mid - h / 2, 1, h);
  }

  if (isPlaying && audioBuffer) {
    const elapsed = ac.currentTime - playStartAcTime;
    const pos     = (playStartSec + elapsed) / audioBuffer.duration;
    if (pos >= 0 && pos <= 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth   = 1;
      ctx.beginPath(); ctx.moveTo(pos * W, 0); ctx.lineTo(pos * W, H); ctx.stroke();
    }
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
  [sx, ex].forEach(x => { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); });

  function knob(x, label) {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, H - 13, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(label, x, H - 9);
  }
  knob(sx, 'S'); knob(ex, 'E');
}

function updateSel() {
  if (!audioBuffer) return;
  const dur = audioBuffer.duration;
  const s = trim.start * dur, e = trim.end * dur;
  document.getElementById('selbadge').textContent =
    fmt(s) + ' \\u2192 ' + fmt(e) + '  (' + fmt(e - s) + ')';
}

fetch('/audio').then(r => r.arrayBuffer()).then(raw => {
  ac.decodeAudioData(raw, buf => {
    audioBuffer = buf;
    peaks = buildPeaks(buf, 2000);
    resize();
    updateSel();
    document.getElementById('info').textContent =
      'Drag the S and E handles to set trim points  \\u00b7  Total duration: ' + fmt(buf.duration);
  });
});

function hit(x) {
  const sx = trim.start * W, ex = trim.end * W;
  if (Math.abs(x - sx) < 12) return 'start';
  if (Math.abs(x - ex) < 12) return 'end';
  if (x > sx && x < ex)      return 'region';
  return null;
}

canvas.addEventListener('mousedown', e => {
  const x = e.clientX - canvas.getBoundingClientRect().left;
  drag = hit(x);
  if (drag === 'region') dragOff = x / W - trim.start;
  else if (!drag) { trim.start = Math.max(0, Math.min(trim.end - 0.01, x / W)); drag = 'start'; drawWaveform(); updateSel(); }
});

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  const nx = (e.clientX - r.left) / W;
  if (drag) {
    if      (drag === 'start')  trim.start = Math.max(0, Math.min(trim.end - 0.01, nx));
    else if (drag === 'end')    trim.end   = Math.max(trim.start + 0.01, Math.min(1, nx));
    else if (drag === 'region') { const w = trim.end - trim.start; trim.start = Math.max(0, Math.min(1 - w, nx - dragOff)); trim.end = trim.start + w; }
    drawWaveform(); updateSel();
  }
  const h = hit(e.clientX - r.left);
  canvas.style.cursor = h === 'region' ? 'move' : h ? 'ew-resize' : 'default';
});

canvas.addEventListener('mouseup',    () => { drag = null; });
canvas.addEventListener('mouseleave', () => { drag = null; });

(function loop() { if (isPlaying) drawWaveform(); requestAnimationFrame(loop); })();

document.getElementById('playbtn').addEventListener('click', () => {
  if (!audioBuffer) return;
  if (isPlaying) { playSource?.stop(); isPlaying = false; document.getElementById('playbtn').textContent = '\\u25b6 Play selection'; return; }
  const dur = audioBuffer.duration, start = trim.start * dur, end = trim.end * dur;
  playSource = ac.createBufferSource();
  playSource.buffer = audioBuffer;
  playSource.connect(ac.destination);
  playSource.start(0, start, end - start);
  isPlaying = true; playStartAcTime = ac.currentTime; playStartSec = start;
  document.getElementById('playbtn').textContent = '\\u23f9 Stop';
  playSource.onended = () => { isPlaying = false; document.getElementById('playbtn').textContent = '\\u25b6 Play selection'; };
});

function closeUI(msg, color) {
  document.getElementById('btns').style.display = 'none';
  canvas.style.display = 'none';
  document.getElementById('controls').style.display = 'none';
  const d = document.getElementById('done');
  d.style.display = 'block'; d.style.color = color; d.textContent = msg;
}

document.getElementById('apply').addEventListener('click', () => {
  if (!audioBuffer) return;
  const dur = audioBuffer.duration;
  fetch('/trim', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: trim.start * dur, end: trim.end * dur }) })
    .then(() => closeUI('\\u2713 Trim applied. You can close this tab.', '#2a7d46'));
});

document.getElementById('cancel').addEventListener('click', () => {
  fetch('/cancel', { method: 'POST' })
    .then(() => closeUI('Cancelled. You can close this tab.', '#777'));
});

document.getElementById('reselect').addEventListener('click', () => {
  fetch('/reselect', { method: 'POST' })
    .then(() => closeUI('Returning to file selection\\u2026 You can close this tab.', '#777'));
});
</script>
</body>
</html>`;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav' }[ext] || 'audio/mpeg';
}

async function trimAudioInteractive(filePath) {
  const http    = require('http');
  const ext     = path.extname(filePath);
  const outPath = path.join(
    path.dirname(filePath),
    path.basename(filePath, ext) + '-trimmed' + ext,
  );
  const audioBuf = fs.readFileSync(filePath);
  const mime     = getMimeType(filePath);
  const html     = buildTrimHtml();

  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else if (req.method === 'GET' && req.url === '/audio') {
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': audioBuf.length });
        res.end(audioBuf);
      } else if (req.method === 'POST' && req.url === '/trim') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          res.writeHead(200); res.end('ok');
          server.close();
          try {
            const { start, end } = JSON.parse(body);
            execSync(
              `ffmpeg -y -i "${filePath}" -ss ${start.toFixed(3)} -to ${end.toFixed(3)} "${outPath}"`,
              { stdio: 'pipe' },
            );
            console.log(`\n  ${c.green('✓')} Trimmed: ${c.dim(path.basename(outPath))}`);
            resolve(outPath);
          } catch (err) {
            const msg = err.stderr?.toString().trim().split('\n').pop() || err.message;
            console.error(`\n  ${c.red('✗')} Trim failed: ${msg}`);
            resolve(null);
          }
        });
      } else if (req.method === 'POST' && req.url === '/cancel') {
        res.writeHead(200); res.end('ok');
        server.close();
        resolve(null);
      } else if (req.method === 'POST' && req.url === '/reselect') {
        res.writeHead(200); res.end('ok');
        server.close();
        resolve('__reselect__');
      } else {
        res.writeHead(404); res.end();
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log(c.dim('  Opening audio trimmer in browser...'));
      execSync(`open "http://127.0.0.1:${port}"`);
    });
  });
}

async function createReelVideo(iface) {
  if (!hasFFmpeg()) {
    console.log(`  ${c.red('✗')} ffmpeg is not installed. Install with: ${c.dim('brew install ffmpeg')}`);
    return null;
  }

  let imagePath = await promptImageForReel(iface);
  if (!imagePath) return null;

  // Offer crop if image isn't already 9:16
  const dims = getImageDimensions(imagePath);
  if (dims) {
    const ratio       = dims.width / dims.height;
    const targetRatio = 9 / 16;
    if (Math.abs(ratio - targetRatio) > 0.05) {
      const wider = ratio > targetRatio;
      console.log(`\n  ${c.dim(path.basename(imagePath))}  ${c.dim(`${dims.width}×${dims.height}`)}`);
      console.log(`  ${c.yellow('⚠')} Image is ${wider ? 'wider' : 'taller'} than 9:16 — ffmpeg will add black bars on the ${wider ? 'top and bottom' : 'left and right'}`);
      console.log(`    ${c.dim('[c]')} Crop to 9:16 first   ${c.dim('[s]')} Keep black bars`);
      const fix = (await ask(iface, '  > ')).trim().toLowerCase();
      if (fix === 'c') {
        const cropped = await cropImage(imagePath, 9, 16);
        if (cropped) imagePath = cropped;
      }
    }
  }

  let audioPath;
  while (true) {
    audioPath = await promptMp3(iface);
    if (!audioPath) return null;

    console.log(c.dim('\n  Trim audio?'));
    console.log(`    ${c.dim('[t]')} Open trim tool   ${c.dim('[enter]')} Use full audio`);
    const trimChoice = (await ask(iface, '  > ')).trim().toLowerCase();
    if (trimChoice === 't') {
      const trimmed = await trimAudioInteractive(audioPath);
      if (trimmed === '__reselect__') continue;
      if (trimmed) audioPath = trimmed;
    }
    break;
  }

  console.log(c.dim('\n  Audio fade-out:'));
  console.log(`    ${c.dim('[1]')} 1 second (default)   ${c.dim('[3]')} 3 seconds   ${c.dim('[5]')} 5 seconds   ${c.dim('[n]')} No fade`);
  const fadeInput = (await ask(iface, '  > ')).trim().toLowerCase();
  const fadeSecs  = fadeInput === '3' ? 3 : fadeInput === '5' ? 5 : fadeInput === 'n' ? 0 : 1;

  const imgBase   = path.basename(imagePath, path.extname(imagePath)).replace(/[^a-z0-9]/gi, '-');
  const audioBase = path.basename(audioPath, path.extname(audioPath)).replace(/[^a-z0-9]/gi, '-');
  const outPath   = path.join(PROMO_VIDEOS_DIR, `reel-${imgBase}-${audioBase}.mp4`);

  // Audio filter: fade out the end, then strip any remaining trailing silence
  const audioFilters = [
    fadeSecs > 0 ? `areverse,afade=t=in:ss=0:d=${fadeSecs},areverse` : null,
    'silenceremove=stop_periods=-1:stop_duration=0.3:stop_threshold=-50dB',
  ].filter(Boolean).join(',');

  console.log(c.dim('\n  Composing Reel (this may take a moment)...'));
  console.log(c.dim(`  Image: ${path.basename(imagePath)}`));
  console.log(c.dim(`  Audio: ${path.basename(audioPath)}${fadeSecs > 0 ? `  (${fadeSecs}s fade-out)` : ''}`));

  try {
    // Scale image to fit 1080×1920 (9:16), pad remaining space with black
    execSync([
      'ffmpeg', '-y',
      '-loop', '1',
      `-i "${imagePath}"`,
      `-i "${audioPath}"`,
      `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black"`,
      `-af "${audioFilters}"`,
      '-c:v libx264', '-tune stillimage', '-preset fast',
      '-c:a aac', '-b:a 192k',
      '-pix_fmt yuv420p',
      '-shortest',
      `-t 60`,
      `"${outPath}"`,
    ].join(' '), { stdio: 'pipe' });

    console.log(`  ${c.green('✓')} Created: ${c.dim(path.basename(outPath))}`);
    await pushVideoToGit(outPath);
    return { videoPath: outPath, thumbnailPath: imagePath };
  } catch (err) {
    const stderr = err.stderr?.toString().trim().split('\n').pop() || err.message;
    console.error(`  ${c.red('✗')} ffmpeg failed: ${stderr}`);
    return null;
  }
}

// ---- hashtag prompt ----

const HASHTAG_TIPS = {
  instagram: {
    post:  { count: '3–5', tip: 'Niche tags outperform generic ones. Instagram recommends fewer, more specific tags.' },
    reel:  { count: '3–5', tip: 'Include at least one niche tag. Avoid stuffing — Reels are discovered mainly via audio and content.' },
    story: { count: '1–3', tip: 'Hashtags in Stories are indexed but have minimal reach impact. Keep it brief.' },
  },
  facebook: {
    post:  { count: '1–3', tip: 'Facebook deprioritizes hashtag-heavy posts. Use sparingly or skip entirely.' },
    reel:  { count: '1–3', tip: 'Same as Facebook posts — fewer is better.' },
    story: { count: '1–2', tip: 'Minimal impact on Facebook Stories.' },
  },
  youtube: {
    post:  { count: '3–5', tip: 'First 3 hashtags appear above the video title. Always include #Shorts for Shorts content.' },
    reel:  { count: '3–5', tip: 'First 3 hashtags appear above the video title. Always include #Shorts.' },
    story: { count: '3–5', tip: 'First 3 hashtags appear above the video title.' },
  },
};

const DEFAULT_TAGS = '#tumblingdaisies #livemusic #minnesota #rocknroll';

async function promptHashtags(iface, postType) {
  const platforms = [
    BUFFER_IG_CHANNEL && 'instagram',
    BUFFER_FB_CHANNEL && 'facebook',
    BUFFER_YT_CHANNEL && 'youtube',
  ].filter(Boolean);

  console.log(c.dim('\n  Hashtags:'));
  for (const platform of platforms) {
    const { count, tip } = HASHTAG_TIPS[platform][postType];
    console.log(`  ${c.dim(platform + ':')} ${count} tags — ${c.dim(tip)}`);
  }
  console.log(`  ${c.dim('Default:')} ${DEFAULT_TAGS}`);
  console.log(`    ${c.dim('[1]')} Use defaults`);
  console.log(`    ${c.dim('[2]')} Edit defaults`);
  console.log(`    ${c.dim('[3]')} Skip`);
  console.log(`    ${c.dim('[b]')} Back`);

  while (true) {
    const choice = (await ask(iface, '  > ')).trim();
    if (choice === '1') return DEFAULT_TAGS;
    if (choice === '3' || choice === '') return '';
    if (choice === 'b') return BACK;
    if (choice === '2') {
      const edited = (await askPrefilled(iface, '  > ', DEFAULT_TAGS)).trim();
      return edited || DEFAULT_TAGS;
    }
    console.error('  Enter 1, 2, or 3.');
  }
}

// ---- per-gig prompts ----

async function askCaption(iface) {
  while (true) {
    const caption = await ask(iface, '\n  Caption (b = back): ');
    if (caption.trim().toLowerCase() === 'b') return BACK;
    if (caption.trim()) return caption;
    console.error('  Caption cannot be empty.');
  }
}

async function promptPostType(iface) {
  console.log(c.dim('\n  Post type:'));
  console.log(`    ${c.dim('[1]')} Post   ${c.dim('[2]')} Reel   ${c.dim('[3]')} Story   ${c.dim('[b]')} Back`);
  while (true) {
    const v = (await ask(iface, '  > ')).trim();
    if (v === '1') return 'post';
    if (v === '2') return 'reel';
    if (v === '3') return 'story';
    if (v === 'b') return BACK;
    console.error('  Enter 1, 2, or 3.');
  }
}

async function promptMedia(iface, postType) {
  const folderLabel = postType === 'reel' ? 'promo-videos folder' : 'assets folder (press / ig / social / fb / yt)';
  console.log(c.dim('\n  Media:'));
  console.log(`    ${c.dim('[1]')} Choose from ${folderLabel}`);
  console.log(`    ${c.dim('[2]')} Choose file`);
  if (postType === 'reel') console.log(`    ${c.dim('[3]')} Create from image + MP3`);
  console.log(`    ${c.dim('[' + (postType === 'reel' ? 4 : 3) + ']')} Skip`);
  console.log(`    ${c.dim('[b]')} Back`);

  const skipChoice = postType === 'reel' ? '4' : '3';

  while (true) {
    const choice = (await ask(iface, '  > ')).trim();

    if (choice === 'b') return BACK;
    if (choice === skipChoice || choice === '') return { filePath: null, thumbnailPath: null };

    // Reel-only: compose video from image + audio
    if (postType === 'reel' && choice === '3') {
      const result = await createReelVideo(iface);
      if (!result) continue;
      // thumbnailPath is the source image; ffmpeg output is always 1080×1920, no dimension check needed
      return { filePath: result.videoPath, thumbnailPath: result.thumbnailPath };
    }

    let filePath = null;

    if (choice === '1') {
      const files = listAssets(postType);
      if (files.length === 0) {
        console.log(c.dim(`  No files found in ${folderLabel}.`));
        continue;
      }
      console.log();
      files.forEach((f, i) => {
        const name   = path.basename(f);
        const isImg  = IMAGE_EXTS.includes(path.extname(f).toLowerCase());
        const dims   = isImg ? getImageDimensions(f) : null;
        const dimStr = dims ? c.dim(` ${dims.width}×${dims.height}`) : '';
        console.log(`    ${c.dim(`[${i + 1}]`)} ${name}${dimStr}`);
      });
      const sel = (await ask(iface, '\n  > ')).trim();
      const n   = parseInt(sel, 10);
      if (!n || n < 1 || n > files.length) { console.error('  Invalid selection.'); continue; }
      filePath = files[n - 1];
    }

    if (choice === '2') {
      console.log(c.dim('  Opening file picker...'));
      filePath = openFilePicker(postType);
      if (!filePath) { console.log(c.dim('  No file selected.')); continue; }
    }

    if (!filePath) continue;

    // For Reels: ensure any selected promo-video is reachable via a public URL
    if (postType === 'reel' && !pushedToGit.has(filePath)) {
      const repoRoot = path.join(__dirname, '..');
      const rel      = path.relative(repoRoot, filePath);
      const isTracked = (() => {
        try { execSync(`git ls-files --error-unmatch "${rel}"`, { cwd: repoRoot, stdio: 'pipe' }); return true; }
        catch { return false; }
      })();

      if (isTracked) {
        pushedToGit.add(filePath); // already on GitHub from a previous session
      } else {
        console.log(`\n  ${c.dim(path.basename(filePath))} is not yet on GitHub`);
        console.log(`    ${c.dim('[p]')} Push to GitHub now   ${c.dim('[s]')} Skip (attach manually in Buffer)`);
        const ans = (await ask(iface, '  > ')).trim().toLowerCase();
        if (ans === 'p') await pushVideoToGit(filePath);
      }
    }

    // Validate — loop so cropping can be retried
    while (true) {
      const { warnings, errors } = checkMedia(filePath, postType);
      console.log(`\n  ${c.dim(path.basename(filePath))}`);
      errors.forEach(e   => console.log(`  ${c.red('✗')} ${e}`));
      warnings.forEach(w => console.log(`  ${c.yellow('⚠')} ${w}`));

      if (errors.length) {
        const cropTarget = getCropTarget(filePath, postType);
        if (cropTarget) {
          console.log(`    ${c.dim('[c]')} Crop to fix   ${c.dim('[r]')} Select a different file`);
          const fix = (await ask(iface, '  > ')).trim().toLowerCase();
          if (fix === 'c') {
            const cropped = await cropImage(filePath, cropTarget.w, cropTarget.h);
            if (cropped) { filePath = cropped; continue; } // re-validate cropped file
          }
        } else {
          console.log(c.dim('  Please select a different file.'));
        }
        break; // back to file selection
      }

      if (warnings.length) {
        const ok = (await ask(iface, '  Use this file anyway? [y/N] ')).trim().toLowerCase() === 'y';
        if (!ok) break;
      }

      // For Reels with an existing video, offer thumbnail selection
      let thumbnailPath = null;
      if (postType === 'reel' && VIDEO_EXTS.includes(path.extname(filePath).toLowerCase())) {
        console.log(c.dim('\n  Thumbnail (cover image for the Reel):'));
        console.log(`    ${c.dim('[1]')} Choose from assets folder`);
        console.log(`    ${c.dim('[2]')} Choose file`);
        console.log(`    ${c.dim('[3]')} Skip`);
        const tc = (await ask(iface, '  > ')).trim();
        if (tc === '1') {
          const imgs = listAssets('post');
          if (imgs.length) {
            imgs.forEach((f, i) => console.log(`    ${c.dim(`[${i + 1}]`)} ${path.basename(f)}`));
            const sel = (await ask(iface, '\n  > ')).trim();
            const n   = parseInt(sel, 10);
            if (n >= 1 && n <= imgs.length) thumbnailPath = imgs[n - 1];
          } else {
            console.log(c.dim('  No images found.'));
          }
        } else if (tc === '2') {
          console.log(c.dim('  Opening file picker...'));
          thumbnailPath = openFilePicker('post') || null;
        }
      }

      return { filePath, thumbnailPath };
    }
  }
}

// ---- main ----

async function main() {
  if (SHOW_HELP || process.argv.length === 2) {
    printHelp();
    process.exit(0);
  }

  if (AUTH) {
    await runAuth();
    process.exit(0);
  }

  if (LIST_SHOWS) {
    await listShows(loadUpcomingGigs());
    process.exit(0);
  }

  if (!SCHEDULE_POSTS && !DRY_RUN) {
    printHelp();
    process.exit(0);
  }

  if (!DRY_RUN) checkEnv();

  const gigs = loadUpcomingGigs();
  if (gigs.length === 0) {
    console.log('No upcoming confirmed public gigs found in data/gigs.json.');
    process.exit(0);
  }

  printGigList(gigs);

  const iface = rl();

  let selectedIndices;
  while (true) {
    const sel = await ask(iface, '\nSelect gigs (numbers separated by commas, or "all"): ');
    try {
      selectedIndices = parseSelection(sel, gigs.length);
      break;
    } catch (e) {
      console.error(`  ${e.message} — try again.`);
    }
  }

  const selectedGigs = selectedIndices.map(i => gigs[i]);
  console.log(c.dim('\nSelected:'));
  selectedGigs.forEach(g =>
    console.log(`  ${c.cyan(formatDate(g.date))}  ${c.bold(g.eventName || g.venue)}`)
  );

  // RULE: no AI-generated content — captions must be written by the user
  const gigPosts = [];
  for (const g of selectedGigs) {
    const name = g.eventName || g.venue;
    const printHeader = () => {
      console.log(`\n${c.bold(name)}  ${c.dim(formatDate(g.date))}`);
      if (g.showtime) console.log(c.dim(`  ${g.showtime}${g.cover ? '  ·  ' + g.cover : ''}`));
    };
    printHeader();

    // Step-based loop so [b] can navigate back to the previous step
    let step = 0;
    let postType, mediaPath, thumbnailPath, caption, hashtags;

    while (step < 4) {
      if (step === 0) {
        const r = await promptPostType(iface);
        if (r === BACK) { printHeader(); continue; } // already at first step — re-display header
        postType = r; step++;

      } else if (step === 1) {
        const r = await promptMedia(iface, postType);
        if (r === BACK) { step--; continue; }
        ({ filePath: mediaPath, thumbnailPath } = r);
        step++;

      } else if (step === 2) {
        const r = await askCaption(iface);
        if (r === BACK) { step--; continue; }
        caption = r; step++;

      } else if (step === 3) {
        const r = await promptHashtags(iface, postType);
        if (r === BACK) { step--; continue; }
        hashtags = r; step++;
      }
    }

    const fullText = hashtags ? `${caption.trim()}\n\n${hashtags}` : caption.trim();
    gigPosts.push({ gig: g, postType, mediaPath, thumbnailPath, caption: fullText });
  }

  let daysBefore;
  while (true) {
    const d = await ask(iface, '\nSchedule how many days before each show? (0 = day of show): ');
    daysBefore = parseInt(d.trim(), 10);
    if (!isNaN(daysBefore) && daysBefore >= 0) break;
    console.error('  Enter a non-negative integer.');
  }

  let postTime;
  while (true) {
    postTime = await ask(iface, 'At what time of day? (e.g. "10:00 AM" or "14:00"): ');
    try {
      buildScheduledAt('2000-01-15', 0, postTime);
      break;
    } catch (e) {
      console.error(`  ${e.message}`);
    }
  }

  iface.close();

  console.log(c.dim('\n─── Post previews ───\n'));
  const posts = gigPosts.map(({ gig, postType, mediaPath, thumbnailPath, caption }) => {
    const scheduledAt = buildScheduledAt(gig.date, daysBefore, postTime);
    const name        = gig.eventName || gig.venue;
    console.log(`${c.cyan(formatDate(gig.date))}  ${c.bold(name)}  ${c.dim(`[${postType}]`)}`);
    if (mediaPath)    console.log(c.dim(`Media:     ${path.basename(mediaPath)}`));
    if (thumbnailPath) console.log(c.dim(`Thumbnail: ${path.basename(thumbnailPath)}`));
    console.log(c.dim(`Scheduled: ${new Date(scheduledAt).toLocaleString()}`));
    console.log(c.dim('─────────────────────'));
    console.log(caption);
    console.log(c.dim('─────────────────────\n'));
    return { gig, postType, text: caption, mediaPath, thumbnailPath, scheduledAt };
  });

  if (DRY_RUN) {
    console.log(c.dim('[dry-run] Skipping Buffer submission.'));
    process.exit(0);
  }

  const iface3 = rl();

  const humanAuthored = await new Promise(resolve => {
    iface3.question(
      `I confirm this content was written by me, not AI-generated. [y/N] `,
      ans => resolve(ans.trim().toLowerCase() === 'y')
    );
  });

  if (!humanAuthored) {
    iface3.close();
    console.log('Post cancelled — content must be human-written.');
    process.exit(0);
  }

  const confirm = await new Promise(resolve => {
    iface3.question(
      `Submit ${posts.length} post(s) to Buffer for ${activeChannels().map(ch => ch.label).join(', ')}? [y/N] `,
      ans => { iface3.close(); resolve(ans.trim().toLowerCase() === 'y'); }
    );
  });

  if (!confirm) { console.log('Aborted.'); process.exit(0); }

  let ok = 0;
  for (const { gig, postType, text, mediaPath, thumbnailPath, scheduledAt } of posts) {
    const name = gig.eventName || gig.venue;
    process.stdout.write(`  ${c.cyan(formatDate(gig.date))}  ${name}  ${c.dim(`[${postType}]`)} ... `);
    try {
      await postToBuffer(text, scheduledAt, mediaPath, postType, thumbnailPath);
      console.log(c.green('done'));
      ok++;
    } catch (e) {
      console.log(c.red('FAILED'));
      console.error(c.dim(`    ${e.message}`));
    }
  }

  const allOk = ok === posts.length;
  console.log(`\n${allOk ? c.green('✓') : c.red('✗')} ${ok}/${posts.length} post(s) queued in Buffer.`);
}

main().catch(e => {
  console.error(c.red('Fatal error:'), e.message);
  process.exit(1);
});
