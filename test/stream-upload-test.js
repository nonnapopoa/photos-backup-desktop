'use strict';

// Streaming-upload regression tests.
// 1. A slow, backpressured server reading an 8 MB body in small chunks —
//    the old hand-rolled pull()/once('readable') stream deadlocked here.
// 2. A server that stops reading mid-body — the watchdog must turn the stall
//    into a retryable transport error instead of hanging forever.
// Run with: node test/stream-upload-test.js

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamUpload, GPMCError } = require('../src/main/gpmc');

function makeServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function main() {
  const tmp = path.join(os.tmpdir(), `pb-stream-test-${Date.now()}.bin`);
  const content = crypto.randomBytes(8 * 1024 * 1024); // many chunks at 256 KB HWM
  fs.writeFileSync(tmp, content);

  try {
    // 1. Slow reader: pause/resume per chunk — classic backpressured consumer.
    {
      let received = Buffer.alloc(0);
      const { server, base } = await makeServer((req, res) => {
        req.on('data', (chunk) => {
          received = Buffer.concat([received, chunk]);
          req.pause();
          setTimeout(() => req.resume(), 10);
        });
        req.on('end', () => { res.writeHead(200); res.end('done'); });
      });
      const progress = [];
      const watchdog = setTimeout(() => { console.error('WATCHDOG: slow-reader upload hung'); process.exit(2); }, 30000);
      const response = await streamUpload(base + '/put', tmp, { 'Content-Type': 'application/octet-stream' },
        (sent, total) => progress.push([sent, total]));
      clearTimeout(watchdog);
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(received, content, 'byte-exact body');
      assert.ok(progress.length > 10, `progress reported ${progress.length} times`);
      assert.strictEqual(progress[progress.length - 1][0], content.length, 'final progress is the full size');
      console.log(`test 1 OK: slow reader completed byte-exact (${progress.length} progress callbacks)`);
      server.closeAllConnections();
      server.close();
    }

    // 2. Server stops reading after 128 KB; watchdog (1200 ms idle) must abort.
    {
      const { server, base } = await makeServer((req, res) => {
        req.once('data', () => {
          req.removeAllListeners('data');
          req.pause();
          // Never resume, never respond.
        });
      });
      const started = Date.now();
      await assert.rejects(
        streamUpload(base + '/stall', tmp, { 'Content-Type': 'application/octet-stream' },
          () => {}, undefined, { idleTimeoutMs: 1200 }),
        (error) => {
          assert.ok(error instanceof GPMCError, 'is a GPMCError');
          assert.strictEqual(error.kind, 'transport');
          assert.ok(error.retryable, 'stall is retryable');
          assert.match(error.message, /stalled/i);
          return true;
        },
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 10000, `aborted promptly (took ${elapsed}ms)`);
      console.log(`test 2 OK: stall aborted after ${elapsed}ms as a retryable transport error`);
      server.closeAllConnections();
      server.close();
    }

    console.log('stream-upload-test: all assertions passed');
    process.exit(0);
  } finally {
    fs.unlinkSync(tmp);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
