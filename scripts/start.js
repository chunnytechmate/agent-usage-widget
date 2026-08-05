#!/usr/bin/env node
'use strict';
// Cross-platform launcher for agent-usage-widget.
//   npm start        → node scripts/start.js
//   npm run dev      → node scripts/start.js --dev
//
// Why this exists instead of `electron .` directly:
//   1. `ELECTRON_RUN_AS_NODE` is set by some parent shells (VS Code's remote
//      server, Claude Code's own runtime). When present, Electron boots as a
//      plain Node.js process and never opens its window — the widget silently
//      does nothing. We clear it before launching.
//   2. On Linux the Chrome setuid sandbox needs root ownership + mode 4755 to
//      run; without sudo to set that up, Electron refuses to start. When the
//      sandbox isn't usable we fall back to `--no-sandbox` so the app still
//      runs for a local single-user widget.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Resolve the Electron binary path. `require('electron')` returns the absolute
// path to the installed binary (it throws if the postinstall download failed).
let electronPath;
try {
  // `require('electron')` returns the binary path string (throws if the
  // postinstall download never completed).
  electronPath = require('electron');
} catch {
  console.error('\x1b[31mElectron is not installed correctly.\x1b[0m');
  console.error('Run \x1b[1mnpm install\x1b[0m again, or');
  console.error('  rm -rf node_modules/electron && npm install');
  process.exit(1);
}

// Never let a parent shell force Electron into headless-Node mode.
delete process.env.ELECTRON_RUN_AS_NODE;

const args = [ROOT];

// Forward our own flags (e.g. --dev) to Electron.
args.push(...process.argv.slice(2));

// On Linux, only initialise the setuid sandbox if it's actually usable;
// otherwise fall back to --no-sandbox so the window still opens without sudo.
if (os.platform() === 'linux') {
  const sandbox = path.join(path.dirname(electronPath), 'chrome-sandbox');
  let sandboxUsable = false;
  try {
    const st = fs.statSync(sandbox);
    const setuid = (st.mode & 0o4000) !== 0; // setuid bit
    sandboxUsable = setuid && st.uid === 0;  // owned by root
  } catch {
    sandboxUsable = false;
  }
  if (!sandboxUsable) args.push('--no-sandbox');
}

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => process.exit(code ?? 0));
