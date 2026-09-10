# Photos Backup (Desktop)

An experimental Electron desktop app that backs up folders of photos and videos to
Google Photos. It is a port of the [PhotosBackup iOS app](https://github.com/g8row/PhotosBackup):
the same Google authentication route, the same private Photos upload protocol, with
the iOS Photos library replaced by folders you choose.

> **Warning** — Uses Google's private, undocumented Photos endpoints and an
> Android-style authentication flow. Not affiliated with or endorsed by Google;
> may stop working without notice. Experimental software, use at your own risk.

## How the port maps

| iOS app | This app |
| --- | --- |
| WKWebView `EmbeddedSetup` + `WKHTTPCookieStore` polling | `BrowserWindow` with an in-memory session + `session.cookies` polling for the HttpOnly `oauth_token` |
| Token exchange (`TokenExchange.swift`) | `src/main/tokenExchange.js` |
| GPMC client (`GPMCClient.swift`, `Protobuf.swift`) | `src/main/gpmc.js`, `src/main/proto.js` |
| Keychain credential (`CredentialStore.swift`) | Electron `safeStorage`-encrypted file under userData |
| PHPhotoLibrary albums + PHPicker | Folder picker + recursive media scan (`src/main/mediaScanner.js`) |
| BGProcessingTask background windows | Desktop queue with pause/resume/cancel and per-account skip memory |
| SwiftUI views | Plain HTML/CSS/JS renderer |

Uploads follow the iOS app's exact scheduling technique: oldest-first, SHA-1
hash dedup against Google's side before any bytes move, resumable upload
sessions, and the upstream retry schedule (`min(30, 2^attempt)`, 3 attempts).
As of upstream 0.3.4, a manual **Back up now** queues the whole selection —
the 250-item batch cap is an automatic-pass technique only, so the desktop port
paces quota at the request level instead: HTTP 429 pauses new item starts for
a minute. **Simultaneous uploads** is configurable from 1 to 10 (upstream
0.3.2; default 2).

Error handling matches upstream 0.3.5: Google's `google.rpc.Status` protobuf
is decoded, so failures name their canonical code and a readable message
instead of a hex dump. `RESOURCE_EXHAUSTED` without HTTP 429 means the account
is out of storage — non-retryable, and the queue halts until space is freed.
A rejected credential halts the queue the same way. Upload receipts are
validated (field 2 must carry the upload token); a commit that rejects the
receipt (`INVALID_ARGUMENT`) re-runs the preflight and transfer instead of
failing the item. Each run first requeues any previously failed items whose
errors were transient.

Two toggles mirror the iOS app's Settings → Backup, with the same defaults:
**Storage Saver** (off) and **Count against storage quota** (off — uploads go
up as Pixel XL originals that do not consume your Google storage).
**Re-check backups** (upstream "Verify Backup") forgets the local completed
record and re-queues everything; the Google-side hash lookup reports files
still present as "already backed up" and re-uploads anything missing.

## Requirements

- Node.js 18+ (tested on 26)
- An Electron-capable OS (macOS, Windows, Linux)

## Run from source

```bash
npm install
npm start
```

If npm blocks Electron's postinstall binary download, allow it and reinstall, or run
`node node_modules/electron/install.js`.

## Run the tests

```bash
node test/upload-flow-test.js        # full upload pipeline against a mock Google server
node test/stream-upload-test.js      # backpressured streaming PUT + stall watchdog
node test/queue-test.js              # backoff, 429 cooldown, halts, releases, concurrency
node test/status-test.js             # google.rpc.Status parsing, storageFull, receipts
npx electron test/signin-smoke.js    # real EmbeddedSetup page: sign-in form vs. "not secure" block
SMOKE_DEVTOOLS=1 npx electron test/signin-smoke.js   # same, with devtools attached
```

The upload test covers token refresh, hash dedup (both hit and miss), resumable
session negotiation, byte-exact streaming PUT with auth headers, and the commit
RPC with its `x-goog-ext-*` headers. The sign-in smoke test loads the real
Google page in the exact environment the app builds and exits 0 when the
sign-in form renders, 2 if Google shows the security block.

### Why the sign-in window presents as iPhone Safari

Google's `EmbeddedSetup` rejects environments it cannot identify with *"This
browser or app may not be secure."* The upstream iOS app's proven configuration
is a full mobile-Safari user agent — Safari sends no client hints, so nothing
contradicts the claim. Reproducing that from Electron takes three things at
once (`src/main/auth.js` + `src/main/authPreload.js`):

1. the iPhone Safari UA, never a Chrome UA;
2. stripping `Sec-CH-UA-*` and `X-Client-Data` request headers Chromium adds
   (a "Safari" request carrying client hints is an instant mismatch);
3. hiding the Chromium-only JS surface (`navigator.userAgentData`,
   `window.chrome`, `navigator.vendor`) via a same-world preload.

## Package installers

```bash
npm run dist       # DMG (mac), NSIS (win), AppImage (linux) into release/
npm run pack       # unpacked app only, faster
```

## Use

1. **Connect Google Account** — a private sign-in window opens. Sign in and accept
   the consent; the page may spin at the end — the app captures the token and closes
   the window on its own.
2. **Add folders** containing your photos/videos.
3. **Back up now.**

Accounts that receive a bound/encrypted master token are unsupported (same
limitation as the iOS app).

## Credential handling

The exchange runs entirely on this machine; there is no companion backend. The
master token is stored as one `safeStorage`-encrypted blob (OS keychain-backed)
under the app's userData directory, never synced. The Google sign-in session lives
in an in-memory session that is wiped the moment the token is captured.

## License

MIT, matching the upstream iOS project.
