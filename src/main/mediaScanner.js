'use strict';

// Folder-based media discovery. The desktop replacement for PHPhotoLibrary:
// instead of album access, the user points the app at folders and we scan them
// recursively for image and video files.

const fs = require('fs/promises');
const path = require('path');

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tif', '.tiff',
  '.bmp', '.avif', '.dng', '.raw',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.mts', '.m2ts', '.mpg', '.mpeg',
]);

const SKIP_DIRECTORIES = new Set([
  '.Trash', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '.git',
]);

function isMediaFile(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

function isHidden(name) {
  return name.startsWith('.');
}

// Recursively scan folders for media files. Returns a flat list of
// { path, filename, size, mtimeMs } sorted by capture date (mtime) so uploads
// run oldest-first, matching the library ordering of the iOS app.
async function scanFolders(folderPaths, { onProgress } = {}) {
  const found = [];
  const visited = new Set();

  async function walk(dir, depth) {
    if (depth > 12 || visited.has(dir)) return;
    visited.add(dir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable (permissions, vanished) — skip
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isHidden(entry.name) && !SKIP_DIRECTORIES.has(entry.name)) {
          await walk(full, depth + 1);
        }
      } else if (entry.isFile() && !isHidden(entry.name) && isMediaFile(entry.name)) {
        try {
          const stat = await fs.stat(full);
          if (stat.size > 0) {
            found.push({ path: full, filename: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
            onProgress?.(found.length);
          }
        } catch { /* vanished mid-scan; skip */ }
      }
    }
  }

  for (const folder of folderPaths) {
    await walk(path.resolve(folder), 0);
  }

  // De-duplicate by path (case-insensitive on Windows-ish filesystems).
  const seen = new Set();
  const unique = found.filter((item) => {
    const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return unique;
}

// Sort paths the user picked or dropped into folders and media files.
// Anything else (documents, empty files, paths that are gone) is counted as
// skipped. Files come back oldest-first, the same order a scan uses.
async function inspectPaths(paths) {
  const folders = [];
  const files = [];
  let skipped = 0;
  for (const raw of paths) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) { skipped += 1; continue; }
    const full = path.resolve(raw);
    let stat;
    try { stat = await fs.stat(full); } catch { skipped += 1; continue; }
    if (stat.isDirectory()) {
      folders.push(full);
    } else if (stat.isFile() && stat.size > 0 && !isHidden(path.basename(full)) && isMediaFile(full)) {
      files.push({ path: full, filename: path.basename(full), size: stat.size, mtimeMs: stat.mtimeMs });
    } else {
      skipped += 1;
    }
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { folders, files, skipped };
}

// For the file picker's filter, without the leading dots.
const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].map((ext) => ext.slice(1));

module.exports = { scanFolders, isMediaFile, inspectPaths, MEDIA_EXTENSIONS };
