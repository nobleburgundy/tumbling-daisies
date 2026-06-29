#!/usr/bin/env node
import { parseFile } from 'music-metadata';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const musicDir = path.join(__dirname, '../assets/music');
const outFile = path.join(__dirname, '../data/music.json');

const files = fs.readdirSync(musicDir).filter(f => f.endsWith('.mp3')).sort();

const tracks = await Promise.all(files.map(async (filename) => {
  const meta = await parseFile(path.join(musicDir, filename));
  const entry = { file: filename };
  if (meta.common.album) entry.album = meta.common.album;
  return entry;
}));

fs.writeFileSync(outFile, JSON.stringify(tracks, null, 2) + '\n');
console.log('Wrote %d tracks to music.json', tracks.length);
