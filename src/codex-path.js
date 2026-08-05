'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// GUI launchers and XDG autostart entries commonly receive a minimal PATH.
// Codex is often installed by npm under a Node version manager, so it can be
// available in an interactive terminal but invisible to the widget. Resolve
// those common user-local locations before falling back to the command name.
function resolveCodexCommand(cfg = {}, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const explicit = cfg.codexPath || env.CODEX_BIN;
  if (explicit) return explicit;

  const names = platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
    : ['codex'];
  const dirs = pathDirs(env.PATH, platform);

  if (home) {
    dirs.push(
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.npm-global', 'bin'),
    );
    dirs.push(...nvmBinDirs(home));
  }

  if (platform === 'win32' && env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));

  for (const dir of unique(dirs)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }

  return 'codex';
}

function pathDirs(value, platform) {
  return String(value || '')
    .split(platform === 'win32' ? ';' : path.delimiter)
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function nvmBinDirs(home) {
  const versionsDir = path.join(home, '.nvm', 'versions', 'node');
  let versions;
  try {
    versions = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareNodeVersionsDesc);
  } catch {
    return [];
  }
  return versions.map((version) => path.join(versionsDir, version, 'bin'));
}

function compareNodeVersionsDesc(a, b) {
  const parse = (value) => String(value).replace(/^v/, '').split('.').map((part) => Number(part) || 0);
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
    if ((av[i] || 0) !== (bv[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
  }
  return 0;
}

function isExecutable(file, platform) {
  try {
    fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = { resolveCodexCommand };
