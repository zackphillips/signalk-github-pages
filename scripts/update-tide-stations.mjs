#!/usr/bin/env node
/**
 * Regenerate site/data/tide_stations.json from NOAA's station metadata.
 *
 *   node scripts/update-tide-stations.mjs
 *
 * Only harmonic ("R") prediction stations go in. Subordinate ("S") stations
 * are offsets from a harmonic one and answer the site's hourly
 * (`interval=h`) predictions request with "No Predictions data was found",
 * so a boat nearest one would get no tide chart at all. The table used to be
 * written by hand, and half its IDs were wrong or did not exist (Oakland's
 * 9418393 is not a station; "Alameda" pointed at Redwood City).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE =
  'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions';
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'site',
  'data',
  'tide_stations.json',
);

// NOAA mixes "SAN FRANCISCO (Golden Gate)" with "Oakland Inner Harbor".
// Title-case the all-caps words so the panel heading reads evenly, leaving
// acronyms and dotted abbreviations (U.S., N.J.) alone.
const ACRONYMS = new Set([
  'AK', 'CBBT', 'GPS', 'ICW', 'ICWW', 'MA', 'MSF', 'NC', 'NERR', 'NOAA', 'NY',
  'PGA', 'RR', 'SW', 'US', 'USCG', 'USS',
]);
function tidyName(name) {
  return name
    .trim()
    .replace(/\b[A-Z][A-Z'-]+\b(?!\.)/g, (w) =>
      ACRONYMS.has(w) ? w : w[0] + w.slice(1).toLowerCase(),
    );
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`NOAA metadata: HTTP ${res.status}`);
const { stations } = await res.json();

const out = stations
  .filter((s) => s.type === 'R' && Number.isFinite(s.lat) && Number.isFinite(s.lng))
  .map((s) => ({
    id: String(s.id),
    name: tidyName(s.name),
    lat: Math.round(s.lat * 1e4) / 1e4,
    lon: Math.round(s.lng * 1e4) / 1e4,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));

const body = out.map((s) => `    ${JSON.stringify(s)}`).join(',\n');
fs.writeFileSync(OUT, `{\n  "stations": [\n${body}\n  ]\n}\n`);
console.log(`Wrote ${out.length} harmonic stations to ${path.relative(process.cwd(), OUT)}`);
