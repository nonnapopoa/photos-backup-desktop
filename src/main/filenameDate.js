'use strict';

// Capture dates read from media filenames, the fallback gotohp offers
// (core/filename_parser.go) for files whose own metadata gives Google no
// date. A time in a name is the camera's wall-clock time, so names are read
// as local time.

const path = require('path');

// Tried in order; the first that yields a real date wins. The first four are
// gotohp's, in gotohp's order.
const PATTERNS = [
  // YYYYMMDD[_-]HHMMSS — IMG_20240709_182027.jpg, PXL_20231123_182518628.jpg
  { re: /(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})\d*/ },
  // YYYY-MM-DD[ _-HHMMSS] — 2022-10-24-150226287.mp4, Screenshot 2026-02-13 093505.png
  { re: /(\d{4})-(\d{1,2})-(\d{1,2})(?:[ _-](\d{2})(\d{2})(\d{2})\d*)?/ },
  // YYYYMMDDHHMMSS on its own — lv_7324034615860006160_20240617193045.mp4
  { re: /(?:^|\D)(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\D|$)/ },
  // Unix milliseconds — FaceApp_1658848332262.jpg (covers 2001–2033)
  { re: /(?:^|\D)(1\d{12})(?:\D|$)/, unixMs: true },
  // YYYYMMDD on its own — VID_20240709.mp4, IMG-20261023-WA0001.jpg. Not in
  // gotohp; last so a name with a time is always read with it.
  { re: /(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/ },
];

// The date in a filename, as { date, hasTime }, or null when there is none.
// Dates before 1990 or more than a year ahead are taken as some other number.
function dateFromFilename(filename, now = new Date()) {
  const base = path.basename(filename || '');
  for (const { re, unixMs } of PATTERNS) {
    const m = base.match(re);
    if (!m) continue;
    let date;
    let hasTime = true;
    if (unixMs) {
      date = new Date(Number(m[1]));
    } else {
      const [year, month, day] = [m[1], m[2], m[3]].map(Number);
      hasTime = m[4] !== undefined;
      const [hour, minute, second] = hasTime ? [m[4], m[5], m[6]].map(Number) : [12, 0, 0];
      if (hour > 23 || minute > 59 || second > 59) continue;
      date = new Date(year, month - 1, day, hour, minute, second);
      // Date rolls 2023-02-31 over into March; a day that does not survive
      // the round trip was never a date.
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) continue;
    }
    const year = date.getFullYear();
    if (!Number.isFinite(year) || year < 1990 || year > now.getFullYear() + 1) continue;
    return { date, hasTime };
  }
  return null;
}

const sameLocalDay = (a, b) => a.getFullYear() === b.getFullYear()
  && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// The date a commit should carry: the filename's when it has one, the
// modification time otherwise. A name with a day but no time keeps the
// modification time when that falls on the same day, since it is the more
// precise of the two, and is placed at noon (gotohp's choice) when it does not.
function captureDate(filename, mtimeMs, now = new Date()) {
  const modified = new Date(mtimeMs);
  const parsed = dateFromFilename(filename, now);
  if (!parsed) return modified;
  if (!parsed.hasTime && sameLocalDay(parsed.date, modified)) return modified;
  return parsed.date;
}

module.exports = { dateFromFilename, captureDate };
