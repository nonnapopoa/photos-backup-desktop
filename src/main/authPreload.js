'use strict';

// Runs in the sign-in window's page world (contextIsolation: false) before any
// Google script loads, removing the JavaScript fingerprints a real Safari
// would not have. No Node or Electron APIs are touched here.

(() => {
  const hide = (target, prop, value) => {
    try {
      Object.defineProperty(target, prop, { get: () => value, configurable: true });
    } catch { /* best effort */ }
  };

  // Safari has no User-Agent Client Hints at all.
  hide(navigator, 'userAgentData', undefined);
  // Safari reports "Apple Computer, Inc."; Chromium reports "Google Inc.".
  hide(navigator, 'vendor', 'Apple Computer, Inc.');
  // Match the iPhone UA.
  hide(navigator, 'platform', 'iPhone');
  hide(navigator, 'maxTouchPoints', 5);

  // window.chrome is a Chromium-only surface.
  try { delete window.chrome; } catch { /* ignore */ }
  hide(window, 'chrome', undefined);
})();
