#!/usr/bin/env node
'use strict';
// Smart first-run setup for agent-usage-widget.
//   - makes sure node_modules is installed
//   - creates a local .env from .env.example (never overwrites an existing one)
//   - reports which providers are ready to use right now
// Run with:  npm run setup

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const CLAUDE_CRED = path.join(os.homedir(), '.claude', '.credentials.json');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function parseDotenv(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function status(label, ok, hint) {
  const mark = ok ? green('✓ ready') : yellow('— not set');
  console.log(`  ${mark}  ${label}`);
  if (!ok && hint) console.log(dim(`        ${hint}`));
}

// Create a Desktop shortcut that launches the widget via start-overlay.vbs (silent,
// no console window), with the bundled app icon. Windows-only; no-op elsewhere.
// Runs during setup so a fresh install gets a clickable launcher automatically.
function createWindowsShortcut() {
  if (process.platform !== 'win32') {
    console.log(`  ${yellow('! skip')}    desktop shortcut (Windows-only)`);
    return;
  }
  const vbs = path.join(ROOT, 'start-overlay.vbs');
  const ico = path.join(ROOT, 'src', 'assets', 'app.ico');
  if (!fs.existsSync(vbs)) {
    console.log(`  ${yellow('! skip')}    desktop shortcut (start-overlay.vbs not found)`);
    return;
  }
  // WScript.Shell COM builds the .lnk. GetFolderPath('Desktop') follows OneDrive /
  // folder-redirection so the shortcut lands on the real desktop. Single quotes in
  // paths are escaped by doubling ('' ), per PowerShell single-quoted-string rules.
  const q = (p) => p.replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference='Stop'`,
    `$ws=New-Object -ComObject WScript.Shell`,
    `$lnk=[Environment]::GetFolderPath('Desktop')+'\\Agent Usage Widget.lnk'`,
    `$s=$ws.CreateShortcut($lnk)`,
    `$s.TargetPath='${q(vbs)}'`,
    `$s.WorkingDirectory='${q(ROOT)}'`,
    `$s.IconLocation='${q(ico)},0'`,
    `$s.Description='Claude + GPT/Codex + Z.AI usage widget'`,
    `$s.Save()`,
    `Write-Output $lnk`,
  ].join(';');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    console.log(`  ${green('✓ shortcut')} ${out}`);
  } catch (e) {
    console.log(`  ${red('! failed')}  desktop shortcut — ${(e.message || '').split('\n')[0]}`);
  }
}

// Create a freedesktop .desktop entry so the widget shows up in the app menu
// (GNOME/KDE/XFCE/Cinnamon) and, best-effort, on the Desktop. Runs during setup
// so a fresh Linux install gets a clickable launcher automatically.
function createLinuxDesktopEntry() {
  if (process.platform !== 'linux') return;
  const startJs = path.join(ROOT, 'scripts', 'start.js');
  const icon = path.join(ROOT, 'src', 'assets', 'tray.png');
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent Usage Widget',
    `Exec=${process.execPath} ${startJs}`,
    `Path=${ROOT}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Utility;',
    'Comment=Real-time rate-limit usage for Claude, GPT/Codex, and Z.AI',
  ].join('\n') + '\n';

  const writeEntry = (file) => { fs.writeFileSync(file, entry); fs.chmodSync(file, 0o755); };

  // App menu entry (~/.local/share/applications/...) — reliable across DEs.
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const appsDir = path.join(dataHome, 'applications');
  try {
    fs.mkdirSync(appsDir, { recursive: true });
    const appEntry = path.join(appsDir, 'agent-usage-widget.desktop');
    writeEntry(appEntry);
    try { fs.unlinkSync(path.join(appsDir, 'claude-usage-widget.desktop')); } catch { /* legacy entry absent */ }
    console.log(`  ${green('✓ launcher')} ${appEntry}`);
  } catch (e) {
    console.log(`  ${red('! failed')}  app-menu entry — ${(e.message || '').split('\n')[0]}`);
  }

  // Best-effort desktop copy (shown by KDE/XFCE/Cinnamon; GNOME needs a desktop-icons extension).
  const desktop = path.join(os.homedir(), 'Desktop');
  if (fs.existsSync(desktop)) {
    try {
      writeEntry(path.join(desktop, 'agent-usage-widget.desktop'));
      try { fs.unlinkSync(path.join(desktop, 'claude-usage-widget.desktop')); } catch { /* legacy entry absent */ }
      console.log(`  ${green('✓ launcher')} ${path.join(desktop, 'agent-usage-widget.desktop')}`);
    } catch { /* non-fatal */ }
  }
}

console.log(bold('\nagent-usage-widget — setup\n'));

// 1) dependencies
if (fs.existsSync(NODE_MODULES)) {
  console.log(`  ${green('✓ ready')}  dependencies installed`);
} else {
  console.log(`  ${yellow('! missing')}  dependencies — run ${bold('npm install')} first`);
}

// 2) .env
if (!fs.existsSync(ENV)) {
  if (fs.existsSync(ENV_EXAMPLE)) {
    fs.copyFileSync(ENV_EXAMPLE, ENV);
    console.log(`  ${green('✓ created')}  .env (copied from .env.example)`);
  } else {
    console.log(`  ${yellow('! missing')}  .env.example — create .env manually with ZAI_API_KEY=`);
  }
} else {
  console.log(`  ${green('✓ exists')}   .env`);
}

// 3) desktop launcher — double-click (Windows) or app menu (Linux) to start the widget
if (process.platform === 'win32') createWindowsShortcut();
else if (process.platform === 'linux') createLinuxDesktopEntry();
else console.log(`  ${yellow('! skip')}    desktop launcher (unsupported on ${process.platform})`);

// 4) provider readiness
const envVals = parseDotenv(ENV);
const zaiKey = (process.env.ZAI_API_KEY || envVals.ZAI_API_KEY || '').trim();
const hasClaude = fs.existsSync(CLAUDE_CRED);
let hasCodex = false;
try {
  execFileSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { stdio: 'ignore' });
  hasCodex = true;
} catch { /* not installed or not on PATH */ }

console.log(bold('\nProviders'));
status('Claude', hasClaude,
  'no ~/.claude/.credentials.json — sign in with Claude Code, or disable Claude');
status('GPT (Codex)', hasCodex,
  'Codex CLI not found — install/sign in to Codex, or disable GPT');
status('Z.AI', !!zaiKey,
  `open ${bold(ENV)} and set ZAI_API_KEY=… , or disable Z.AI`);

console.log(bold('\nProviders (toggle each from the tray → Providers)'));
console.log(`  ${hasClaude ? green('ready') : red('no')}      Claude`);
console.log(`  ${hasCodex ? green('ready') : red('no')}      GPT (Codex)`);
console.log(`  ${zaiKey ? green('ready') : red('no')}      Z.AI`);

console.log(bold('\nNext'));
console.log(`  npm start            ${dim('# launch the widget')}`);
if (process.platform === 'win32') {
  console.log(`  Desktop shortcut     ${dim('# double-click "Agent Usage Widget"')}`);
  console.log(`  start-overlay.vbs    ${dim('# launch with no console window')}`);
} else if (process.platform === 'linux') {
  console.log(`  App menu             ${dim('# find "Agent Usage Widget" in your applications')}`);
  console.log(`  start-overlay.sh     ${dim('# launch with no terminal window')}`);
  console.log(`  Tray → Launch at login ${dim('# start the widget when you sign in')}`);
}
console.log(`  Ctrl+Shift+U         ${dim('# show / hide the overlay')}`);
if (!zaiKey) console.log(yellow(`\n  → edit ${ENV} and add your ZAI_API_KEY to enable Z.AI.\n`));
console.log('');
