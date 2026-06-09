#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../config.json');
const OUTPUT_PATH = path.join(__dirname, '../gigs.json');

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
  return {
    id:          event.id,
    date:        event.start?.dateTime || event.start?.date || null,
    startTime:   event.start?.dateTime || null,
    endTime:     event.end?.dateTime   || null,
    endDate:     event.end?.date       || null,
    venue:       parseVenue(event),
    status:      parseStatus(event),
    title:       event.summary     || '',
    location:    event.location    || '',
    description: event.description || '',
  };
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
}

main().catch(err => { console.error(err.message); process.exit(1); });
