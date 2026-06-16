#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH      = path.join(__dirname, '../config.json');
const OUTPUT_PATH      = path.join(__dirname, '../gigs.json');
const BIT_STATUS_PATH  = path.join(__dirname, '../bit-status.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// ---- Service account auth ----
function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var is not set');
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

// ---- Metadata tag parsing from description ----
// Tags are "Key: Value" lines in the description. Parsed tags are stripped from the
// description text written to gigs.json (the Google Calendar event is never modified).
// "Pay" is intentionally excluded from output.

const METADATA_TAGS = [
  { key: 'showtime',    pattern: /^showtime\s*:\s*(.+)/i },
  { key: 'ticketLink',  pattern: /^ticket\s*link\s*:\s*(.+)/i },
  { key: 'ticketType',  pattern: /^ticket\s*type\s*:\s*(.+)/i },
  { key: 'ticketLink2', pattern: /^ticket\s*link\s*2\s*:\s*(.+)/i },
  { key: 'ticketType2', pattern: /^ticket\s*type\s*2\s*:\s*(.+)/i },
  { key: 'onSaleDate',  pattern: /^on-?\s*sale\s*date\s*:\s*(.+)/i },
  { key: 'onSaleTime',  pattern: /^on-?\s*sale\s*time\s*:\s*(.+)/i },
  { key: 'lineup',      pattern: /^lineup\s*:\s*(.+)/i },
  { key: 'eventName',   pattern: /^event\s*name\s*:\s*(.+)/i },
  { key: 'eventImage',  pattern: /^event\s*image\s*:\s*(.+)/i },
  { key: 'cover',       pattern: /^cover\s*:\s*(.+)/i },
  { key: 'age',         pattern: /^age\s*:\s*(.+)/i },
  { key: 'streamingLink', pattern: /^streaming\s*link\s*:\s*(.+)/i },
  { key: 'scheduledDate', pattern: /^scheduled\s*date\s*:\s*(.+)/i },
  { key: 'scheduledTime', pattern: /^scheduled\s*time\s*:\s*(.+)/i },
  { key: 'bitDescription', pattern: /^description\s*:\s*(.+)/i },
];

// Tags that are parsed but excluded from gigs.json output (sensitive data)
const EXCLUDED_TAGS = ['pay'];
const EXCLUDED_PATTERNS = [
  /^pay\s*:\s*(.+)/i,
];

function parseMetadata(description) {
  if (!description) return { metadata: {}, cleanDescription: '' };

  // Normalize HTML line breaks to newlines for parsing
  let text = description.replace(/<br\s*\/?>/gi, '\n');
  // Strip HTML tags for matching
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

  const lines = text.split('\n');
  const metadata = {};
  const keepLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    let matched = false;

    // Check for excluded tags (parse & discard)
    for (const pat of EXCLUDED_PATTERNS) {
      if (pat.test(trimmed)) { matched = true; break; }
    }
    if (matched) continue;

    // Check for metadata tags
    for (const tag of METADATA_TAGS) {
      const m = trimmed.match(tag.pattern);
      if (m) {
        metadata[tag.key] = m[1].trim();
        matched = true;
        break;
      }
    }
    if (!matched) keepLines.push(line);
  }

  return {
    metadata,
    cleanDescription: keepLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

// ---- Location parsing ----
function parseLocation(location) {
  if (!location) return { city: null, region: null };
  // Try to match "City, ST" or "City, State" patterns
  const match = location.match(/([^,]+),\s*([A-Z]{2})\b/);
  if (match) return { city: match[1].trim(), region: match[2] };
  return { city: null, region: null };
}

// ---- Event parsing (adapted from gig-list) ----
function matchesBand(event) {
  const title = event.summary || '';
  return config.bands.some(band =>
    (band.keywords || []).some(kw => {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(title);
    })
  );
}

function parseStatus(event) {
  const text = [event.summary || '', event.description || ''].join(' ').toLowerCase();
  if (config.confirmedKeywords.some(kw => text.includes(kw.toLowerCase()))) return 'confirmed';
  if (config.holdKeywords.some(kw => text.includes(kw.toLowerCase())))      return 'hold';
  return 'confirmed';
}

function parseVenue(event) {
  if (config.venueSource === 'location') return event.location || '';
  const summary = event.summary || '';
  const atMatch = summary.match(/(?:\bat\s+(?=[A-Za-z])|@\s*)([^(\[{\n]+?)(?:\s*[(\[{]|$)/i);
  if (atMatch) return atMatch[1].trim().replace(/[,\s]+$/, '');
  if (config.venueSummarySeparator) {
    const idx = summary.indexOf(config.venueSummarySeparator);
    if (idx !== -1) return summary.slice(idx + config.venueSummarySeparator.length).trim();
  }
  let venue = summary.replace(/\([^)]{1,30}\)/g, '').trim();
  venue = venue.replace(/^[\s\-–—]+|[\s\-–—]+$/g, '').trim();
  return venue || summary;
}

function parseEvent(event) {
  const { metadata, cleanDescription } = parseMetadata(event.description || '');
  const location = event.location || '';
  const { city, region } = parseLocation(location);

  return {
    id:          event.id,
    date:        event.start?.dateTime || event.start?.date || null,
    startTime:   event.start?.dateTime || null,
    endTime:     event.end?.dateTime   || null,
    endDate:     event.end?.date       || null,
    venue:       parseVenue(event),
    status:      parseStatus(event),
    title:       (event.summary || '').replace(/^\(C\)\s*/i, '').replace(/\bTD\s*(?:at|@)\s*/i, '').replace(/\bTD Trio\b/g, 'Tumbling Daisies Trio'),
    location,
    city:          city || null,
    region:        region || null,
    showtime:      metadata.showtime || null,
    ticketLink:    metadata.ticketLink || null,
    ticketType:    metadata.ticketType || null,
    ticketLink2:   metadata.ticketLink2 || null,
    ticketType2:   metadata.ticketType2 || null,
    onSaleDate:    metadata.onSaleDate || null,
    onSaleTime:    metadata.onSaleTime || null,
    lineup:        metadata.lineup || null,
    eventName:     metadata.eventName || null,
    eventImage:    metadata.eventImage || null,
    cover:         metadata.cover || null,
    age:           metadata.age || null,
    streamingLink: metadata.streamingLink || null,
    scheduledDate: metadata.scheduledDate || null,
    scheduledTime: metadata.scheduledTime || null,
    bitDescription: metadata.bitDescription || null,
    description:   cleanDescription,
  };
}

// ---- Bandsintown published status ----
async function fetchBitStatus() {
  const appId = process.env.BANDSINTOWN_API_KEY;
  if (!appId) {
    console.log('BANDSINTOWN_API_KEY not set — skipping BIT status sync.');
    return;
  }

  const artistId = config.bandsintownArtistId || 'id_15588106';
  const url = `https://rest.bandsintown.com/artists/${artistId}/events/?app_id=${encodeURIComponent(appId)}&date=upcoming`;

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`BIT API returned ${res.status} — skipping BIT status sync.`);
    return;
  }

  const events = await res.json();
  const published = (events || []).map(evt => ({
    date: evt.datetime ? evt.datetime.substring(0, 10) : null,
    venue: evt.venue ? evt.venue.name : null,
  })).filter(e => e.date);

  const status = { fetchedAt: new Date().toISOString(), published };
  fs.writeFileSync(BIT_STATUS_PATH, JSON.stringify(status, null, 2));
  console.log(`Wrote ${published.length} published BIT events to bit-status.json`);
}

// ---- Fetch and write ----
async function main() {
  const auth     = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const now     = new Date();
  const timeMin = new Date(now);
  timeMin.setDate(timeMin.getDate() - (config.daysBack ?? 0));
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + (config.daysAhead ?? 365));

  const response = await calendar.events.list({
    calendarId:   config.calendarId,
    timeMin:      timeMin.toISOString(),
    timeMax:      timeMax.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
    maxResults:   500,
  });

  // Filter to only TD events
  const gigs = (response.data.items || [])
    .filter(ev => matchesBand(ev))
    .map(ev => parseEvent(ev));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ fetchedAt: now.toISOString(), gigs }, null, 2));
  console.log(`Wrote ${gigs.length} TD events to gigs.json`);

  // Fetch BIT published status
  await fetchBitStatus();
}

main().catch(err => { console.error(err.message); process.exit(1); });
