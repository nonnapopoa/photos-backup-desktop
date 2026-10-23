'use strict';

// Folder albums: the CreateAlbum / AddMediaToAlbum wire format ported from
// gotohp, and the queue filing each upload into its parent folder's album.
// Run with: node test/album-test.js

const assert = require('assert');
const path = require('path');
const { UploadQueue, folderAlbumName } = require('../src/main/uploadQueue');
const { GPMCClient, GPMCError } = require('../src/main/gpmc');
const { fields, stringAt, numberAt, bytesField, stringField } = require('../src/main/proto');

const AUTH = 'androidId=a&client_sig=b&callerSig=c&device_country=us&Email=user%40example.com'
  + '&google_play_services_version=1&lang=en&oauth2_foreground=1&sdk_version=28&service=s&Token=t';

function fakeSettings(data = {}) {
  const albums = new Map();
  const completed = new Set();
  return {
    albums,
    completed,
    get: (k) => data[k],
    loadCompleted: () => new Set(completed),
    markCompleted: (_email, sigs) => sigs.forEach((s) => completed.add(s)),
    albumKey: (_email, name) => albums.get(name) || null,
    saveAlbum: (_email, name, key) => { if (key) albums.set(name, key); else albums.delete(name); },
  };
}

const found = (p) => ({ path: p, filename: path.basename(p), size: 10, mtimeMs: 1000 });

function waitIdle(queue) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (queue.isIdle) return resolve();
      if (Date.now() - started > 10000) return reject(new Error('queue never went idle'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function wireFormat() {
  const client = new GPMCClient(AUTH);
  const sent = [];
  client.rpc = async (method, body, opts) => {
    sent.push({ method, body, opts });
    return method === GPMCClient.CREATE_ALBUM_METHOD
      ? bytesField(1, stringField(1, 'AF1QipAlbum')) : Buffer.alloc(0);
  };

  const key = await client.createAlbum('Trip 2024', ['mk1', 'mk2'], { model: 'Pixel 8' });
  assert.strictEqual(key, 'AF1QipAlbum');
  const create = sent[0];
  assert.strictEqual(create.method, '8386163679468898444');
  assert.strictEqual(create.opts.ext, true);
  const c = fields(create.body);
  assert.strictEqual(c[1][0].toString(), 'Trip 2024');
  assert.ok(numberAt(2, create.body) > 0n, 'timestamp');
  assert.strictEqual(numberAt(3, create.body), 1n);
  assert.deepStrictEqual(c[4].map((m) => stringAt([1, 1], m)), ['mk1', 'mk2']);
  assert.strictEqual(c[6][0].length, 0, 'field 6 is an empty message');
  assert.strictEqual(numberAt(1, c[7][0]), 3n);
  assert.strictEqual(stringAt([3], c[8][0]), 'Pixel 8');
  assert.strictEqual(stringAt([4], c[8][0]), 'Google');
  assert.strictEqual(numberAt(5, c[8][0]), 28n);

  await client.addMediaToAlbum('AF1QipAlbum', ['mk3']);
  const add = sent[1];
  assert.strictEqual(add.method, '484917746253879292');
  assert.strictEqual(add.opts.ext, true);
  const a = fields(add.body);
  assert.deepStrictEqual(a[1].map(String), ['mk3']);
  assert.strictEqual(a[2][0].toString(), 'AF1QipAlbum');
  assert.strictEqual(numberAt(1, a[5][0]), 2n);
  assert.strictEqual(stringAt([3], a[6][0]), 'Pixel XL');
  assert.ok(numberAt(7, add.body) > 0n, 'timestamp');

  client.rpc = async () => Buffer.alloc(0);
  await assert.rejects(client.createAlbum('x', ['mk']), (e) => e.kind === 'malformed');
  console.log('test 1 OK: album requests match the gotohp field layout');
}

function albumName() {
  assert.strictEqual(folderAlbumName(path.join('C:\\', 'Photos', 'Trip', 'a.jpg')), 'Trip');
  assert.strictEqual(folderAlbumName(path.join(path.parse(process.cwd()).root, 'a.jpg')), 'Uploads');
  console.log('test 2 OK: the album is named after the immediate parent folder');
}

function stubClient(log, { failAdd = null } = {}) {
  let n = 0;
  return {
    upload: async (p) => {
      await new Promise((r) => setTimeout(r, 5));
      return { outcome: 'uploaded', mediaKey: `mk-${path.basename(p)}` };
    },
    createAlbum: async (name, keys) => {
      await new Promise((r) => setTimeout(r, 20)); // overlap with the other slot
      log.push(['create', name, ...keys]);
      n += 1;
      return `AF1Qip-${name}-${n}`;
    },
    addMediaToAlbum: async (key, keys) => {
      const failure = failAdd?.(key);
      if (failure) throw failure;
      log.push(['add', key, ...keys]);
    },
  };
}

async function oneAlbumPerFolder() {
  const log = [];
  const settings = fakeSettings({ albumsFromFolders: true, concurrency: 2 });
  const queue = new UploadQueue({
    credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => stubClient(log),
  });
  const dir = path.join('C:\\', 'Photos');
  await queue.enqueueScan([
    found(path.join(dir, 'Trip', 'a.jpg')),
    found(path.join(dir, 'Trip', 'b.jpg')),
    found(path.join(dir, 'Home', 'c.jpg')),
  ]);
  await waitIdle(queue);
  const creates = log.filter((e) => e[0] === 'create');
  assert.deepStrictEqual(creates.map((e) => e[1]).sort(), ['Home', 'Trip']);
  assert.deepStrictEqual(log.find((e) => e[0] === 'add'), ['add', settings.albums.get('Trip'), 'mk-b.jpg']);
  assert.strictEqual(settings.completed.size, 3);

  // A later run reuses the saved album rather than making another.
  log.length = 0;
  await queue.enqueueScan([found(path.join(dir, 'Trip', 'd.jpg'))]);
  await waitIdle(queue);
  assert.deepStrictEqual(log, [['add', settings.albums.get('Trip'), 'mk-d.jpg']]);
  console.log('test 3 OK: one album per folder, shared by parallel uploads and reused later');
}

async function refusedAlbumIsRecreated() {
  const log = [];
  const settings = fakeSettings({ albumsFromFolders: true });
  settings.albums.set('Trip', 'AF1Qip-deleted');
  const client = stubClient(log, {
    failAdd: (key) => key === 'AF1Qip-deleted' && new GPMCError('server', 'Google returned HTTP 400 during adding to an album.'),
  });
  const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => client });
  await queue.enqueueScan([found(path.join('C:\\', 'Trip', 'a.jpg'))]);
  await waitIdle(queue);
  assert.deepStrictEqual(log, [['create', 'Trip', 'mk-a.jpg']]);
  assert.strictEqual(settings.albums.get('Trip'), 'AF1Qip-Trip-1');
  assert.strictEqual(queue.items[0].status, 'uploaded');
  console.log('test 4 OK: an album Google refuses is replaced with a new one');
}

async function transientFailureIsNotCompleted() {
  const settings = fakeSettings({ albumsFromFolders: true });
  const client = stubClient([]);
  client.createAlbum = async () => { throw new GPMCError('server', 'Google returned HTTP 400 during album creation.'); };
  const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => client });
  await queue.enqueueScan([found(path.join('C:\\', 'Trip', 'a.jpg'))]);
  await waitIdle(queue);
  assert.strictEqual(queue.items[0].status, 'failed');
  assert.strictEqual(settings.completed.size, 0, 'a file left out of its album is not recorded as done');
  console.log('test 5 OK: an album failure fails the item instead of marking it completed');
}

async function disabled() {
  const log = [];
  const settings = fakeSettings({ albumsFromFolders: false });
  const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => stubClient(log) });
  await queue.enqueueScan([found(path.join('C:\\', 'Trip', 'a.jpg'))]);
  await waitIdle(queue);
  assert.deepStrictEqual(log, []);
  assert.strictEqual(queue.items[0].status, 'uploaded');
  console.log('test 6 OK: with the setting off, no album calls are made');
}

async function pickedFilesSkipAlbums() {
  const log = [];
  const settings = fakeSettings({ albumsFromFolders: true });
  const queue = new UploadQueue({ credential: { authData: AUTH, email: 'u' }, settings, clientFactory: () => stubClient(log) });
  await queue.enqueueScan([{ ...found(path.join('C:\\', 'Trip', 'a.jpg')), skipAlbum: true }]);
  await waitIdle(queue);
  assert.deepStrictEqual(log, []);
  assert.strictEqual(queue.items[0].status, 'uploaded');
  console.log('test 7 OK: files uploaded on their own are not put into a folder album');
}

(async () => {
  await wireFormat();
  albumName();
  await oneAlbumPerFolder();
  await refusedAlbumIsRecreated();
  await transientFailureIsNotCompleted();
  await disabled();
  await pickedFilesSkipAlbums();
  console.log('album tests passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
