'use strict';
// Cross-platform "start at login" helper.
//   win32 / darwin: Electron's app.setLoginItemSettings handles it natively.
//   linux:          that API is a documented no-op here, so we manage an XDG
//                   Autostart .desktop entry ourselves (~/.config/autostart/...),
//                   which GNOME, KDE, XFCE, Cinnamon, etc. honor at session login.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');
const ENTRY_NAME = 'agent-usage-widget.desktop';
const LEGACY_ENTRY_NAME = 'claude-usage-widget.desktop';

function autostartDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'autostart');
}

function autostartFile() {
  return path.join(autostartDir(), ENTRY_NAME);
}

function legacyAutostartFile() {
  return path.join(autostartDir(), LEGACY_ENTRY_NAME);
}

// Wrap a path in double quotes if it contains characters the XDG desktop-entry
// spec treats specially (a space being the realistic case for a home folder).
function quote(p) {
  return /[\s"$`\\]/.test(p) ? `"${p}"` : p;
}

// chrome-sandbox needs setuid root to run; without it Electron refuses to start,
// so mirror scripts/start.js and pass --no-sandbox. Same heuristic, kept local so
// the two entry points stay independent (this module requires electron; that one can't).
function needsNoSandbox() {
  try {
    const st = fs.statSync(path.join(path.dirname(process.execPath), 'chrome-sandbox'));
    return !((st.mode & 0o4000) !== 0 && st.uid === 0);
  } catch {
    return true;
  }
}

function desktopEntry() {
  const exec = [quote(process.execPath), quote(ROOT)];
  if (needsNoSandbox()) exec.push('--no-sandbox');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agent Usage Widget',
    `Exec=${exec.join(' ')}`,
    `Path=${ROOT}`,
    `Icon=${path.join(ROOT, 'src', 'assets', 'tray.png')}`,
    'Terminal=false',
    'Categories=Utility;',
    'X-GNOME-Autostart-enabled=true',
  ].join('\n') + '\n';
}

function isEnabled() {
  if (process.platform === 'linux') {
    try { fs.accessSync(autostartFile()); return true; } catch { /* try legacy name */ }
    try { fs.accessSync(legacyAutostartFile()); return true; } catch { return false; }
  }
  return app.getLoginItemSettings().openAtLogin;
}

function setEnabled(on) {
  if (process.platform === 'linux') {
    const file = autostartFile();
    if (on) {
      fs.mkdirSync(autostartDir(), { recursive: true });
      fs.writeFileSync(file, desktopEntry());
      try { fs.unlinkSync(legacyAutostartFile()); } catch { /* already gone */ }
    } else {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      try { fs.unlinkSync(legacyAutostartFile()); } catch { /* already gone */ }
    }
    return;
  }
  app.setLoginItemSettings({ openAtLogin: !!on });
}

module.exports = { isEnabled, setEnabled };
