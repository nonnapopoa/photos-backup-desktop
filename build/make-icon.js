'use strict';

// Renders build/icon.html (the app's brand mark) at 1024x1024 and saves it as
// build/icon.png, which electron-builder picks up as the app/dmg icon.
// Run with: npx electron build/make-icon.js

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    useContentSize: true,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(__dirname, 'icon.html'));
  // Give the compositor a beat to paint the gradient.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await win.webContents.capturePage();
  const out = path.join(__dirname, 'icon.png');
  fs.writeFileSync(out, image.toPNG());
  console.log(`wrote ${out} (${image.getSize().width}x${image.getSize().height})`);
  app.exit(0);
});
