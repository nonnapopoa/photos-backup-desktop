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

Uploads run oldest-first at concurrency 2, SHA-1 hash each file, ask Google whether
the hash already exists (skipping it if so), then open a resumable upload session,
stream the bytes with progress, and commit with capture-date metadata. Transient
failures (408/429/5xx, network) retry up to 3 times with backoff. Files already
recorded as completed for an account are skipped on later runs without re-hashing.

Quality options match the iOS app: **Original** or **Storage Saver** processing.

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

## Run the protocol tests

```bash
node test/upload-flow-test.js
```

Runs the full upload pipeline against a local mock of Google's endpoints: token
refresh, hash dedup (both hit and miss), resumable session negotiation, byte-exact
streaming PUT with auth headers, and the commit RPC with its `x-goog-ext-*` headers.

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
