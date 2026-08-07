'use strict';
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut, shell } = require('electron');
const config = require('./config');
const { fetchUsage } = require('./usage');
const { fetchGptUsage } = require('./gpt');
const { fetchZaiUsage } = require('./zai');
const { getActiveModel } = require('./active-model');
const { getActivity } = require('./activity');
const { getPeakState } = require('./peak');
const { UsageLogger, logFileFor } = require('./usage-log');
const { trayIconDataUrl } = require('./icon');
const autostart = require('./autostart');

let win = null;
let tray = null;
let pollTimer = null;
let logger = null;
let lastPayload = null;      // newest reading, replayed into a rebuilt window
let lastWindowRebuild = 0;   // crash-loop guard for render-process-gone
let shootTaken = false; // dev-only screenshot gate (fires once when CU_SHOOT=<path> is set)
let cfg = config.DEFAULTS; // real config loaded in whenReady (needs app paths)

const WIN_WIDTH = 268;
const WIN_HEIGHT = 210;

// Default floating position: top-right corner with a small margin.
function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIN_WIDTH - 24, y: wa.y + 24 };
}

// Docked position: bottom-right, sitting flush just above the panel/taskbar. The
// bottom edge pins to the work-area bottom so the widget grows upward as more
// rows render, the way claude-usage-widget's essential mode rests on the bar.
function taskbarPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  const [w, h] = win ? win.getContentSize() : [WIN_WIDTH, WIN_HEIGHT];
  return { x: wa.x + wa.width - w, y: wa.y + wa.height - h };
}

function reposition() {
  if (!win) return;
  const pos = cfg.taskbarMode ? taskbarPos() : (cfg.bounds || defaultPos());
  win.setPosition(pos.x, pos.y);
}

function createWindow() {
  const pos = cfg.taskbarMode ? taskbarPos() : (cfg.bounds || defaultPos());

  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: cfg.alwaysOnTop || cfg.taskbarMode,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Taskbar mode forces always-on-top so it stays above the taskbar and other windows.
  win.setAlwaysOnTop(cfg.alwaysOnTop || cfg.taskbarMode, 'screen-saver');
  win.setOpacity(cfg.opacity);
  win.setIgnoreMouseEvents(cfg.clickThrough, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // A window created after the first poll (or rebuilt after a crash) starts
  // blank, since 'usage-update' only fires on the next poll — up to pollSeconds
  // away. Hand it the last reading as soon as it can receive one.
  win.webContents.on('did-finish-load', () => {
    if (lastPayload && win && !win.isDestroyed()) win.webContents.send('usage-update', lastPayload);
  });

  // A dead renderer used to strand the whole app: no window, and nothing could
  // bring one back, because every entry point was guarded by `if (win)`. Rebuild
  // it once automatically; if it dies again straight away, stop retrying and
  // leave it to the tray, so a reproducible crash can't become a spin loop.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer stopped:', details && details.reason);
    const now = Date.now();
    const looping = now - lastWindowRebuild < 60_000;
    lastWindowRebuild = now;
    if (looping) return;
    setTimeout(() => { if (isDead(win)) rebuildWindow(); }, 1000);
  });

  win.on('moved', () => {
    if (cfg.taskbarMode) return; // docked: ignore manual moves, keep pinned
    const [x, y] = win.getPosition();
    cfg.bounds = { x, y };
    config.save(cfg);
  });

  win.on('closed', () => { win = null; });
}

// Unusable window: gone, destroyed, or still an object whose renderer died —
// a crashed webContents leaves isDestroyed() false and paints nothing, so the
// window has to be judged on the renderer too.
function isDead(w) {
  if (!w || w.isDestroyed()) return true;
  try { return w.webContents.isCrashed(); } catch { return true; }
}

function rebuildWindow() {
  if (win && !win.isDestroyed()) win.destroy(); // fires 'closed', clearing win
  createWindow();
}

// The window is disposable; the app is not. Anything that wants to show the
// widget goes through here, so a missing or broken window is rebuilt instead of
// silently doing nothing.
function ensureWindow() {
  if (isDead(win)) rebuildWindow();
  return win;
}

function createTray() {
  const icon = nativeImage.createFromDataURL(trayIconDataUrl());
  tray = new Tray(icon);
  tray.setToolTip('Agent Usage Widget');
  rebuildTrayMenu();
  tray.on('click', () => toggleShow());
}

function rebuildTrayMenu() {
  const opacityItem = (label, val) => ({
    label,
    type: 'radio',
    checked: Math.abs(cfg.opacity - val) < 0.001,
    click: () => { cfg.opacity = val; if (win) win.setOpacity(val); config.save(cfg); },
  });

  const menu = Menu.buildFromTemplate([
    { label: 'Refresh now', click: () => poll(true) },
    { type: 'separator' },
    {
      label: 'Dock to panel',
      type: 'checkbox',
      checked: cfg.taskbarMode,
      click: (item) => {
        cfg.taskbarMode = item.checked;
        config.save(cfg);
        if (cfg.taskbarMode && win) win.setAlwaysOnTop(true, 'screen-saver');
        reposition();
        rebuildTrayMenu();
      },
    },
    {
      label: 'Click-through (ignore mouse)',
      type: 'checkbox',
      checked: cfg.clickThrough,
      click: (item) => {
        cfg.clickThrough = item.checked;
        if (win) win.setIgnoreMouseEvents(item.checked, { forward: true });
        config.save(cfg);
      },
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: cfg.alwaysOnTop,
      enabled: !cfg.taskbarMode, // taskbar mode already forces on
      click: (item) => {
        cfg.alwaysOnTop = item.checked;
        if (win) win.setAlwaysOnTop(item.checked, 'screen-saver');
        config.save(cfg);
      },
    },
    {
      label: 'Providers',
      submenu: [
        {
          label: 'Claude',
          type: 'checkbox',
          checked: cfg.claudeEnabled,
          click: (item) => setProvider('claude', item.checked),
        },
        {
          label: 'GPT (Codex)',
          type: 'checkbox',
          checked: cfg.gptEnabled,
          click: (item) => setProvider('gpt', item.checked),
        },
        {
          label: 'Z.AI',
          type: 'checkbox',
          checked: cfg.zaiEnabled,
          click: (item) => setProvider('zai', item.checked),
        },
      ],
    },
    {
      label: 'Usage log',
      submenu: [
        {
          label: 'Record usage history',
          type: 'checkbox',
          checked: cfg.loggingEnabled,
          click: (item) => {
            cfg.loggingEnabled = item.checked;
            config.save(cfg);
            if (cfg.loggingEnabled && !logger) initLogger();
          },
        },
        { type: 'separator' },
        { label: "Open today's log", click: () => openLog(true) },
        { label: 'Open log folder', click: () => openLog(false) },
      ],
    },
    {
      label: 'Opacity',
      submenu: [
        opacityItem('100%', 1.0),
        opacityItem('95%', 0.95),
        opacityItem('85%', 0.85),
        opacityItem('70%', 0.70),
        opacityItem('50%', 0.50),
      ],
    },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: autostart.isEnabled(),
      click: (item) => {
        cfg.launchOnStartup = item.checked;
        autostart.setEnabled(item.checked);
        config.save(cfg);
      },
    },
    { type: 'separator' },
    { label: 'Show / Hide  (Ctrl+Shift+U)', click: () => toggleShow() },
    { label: 'Quit', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// Usage history lives beside the config, in Electron's userData folder.
function logDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function initLogger() {
  logger = new UsageLogger({
    dir: logDir(),
    options: {
      retentionDays: cfg.logRetentionDays,
      heartbeatMinutes: cfg.logHeartbeatMinutes,
      idleMinutes: cfg.logIdleMinutes,
      spikePoints: cfg.logSpikePoints,
    },
  });
}

// Open today's log file, falling back to the folder before the first write.
function openLog(todayOnly) {
  const fs = require('fs');
  const dir = logDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = logFileFor(dir);
    shell.openPath(todayOnly && fs.existsSync(file) ? file : dir);
  } catch (e) {
    console.error('Could not open the usage log:', e.message);
  }
}

function toggleShow() {
  const w = ensureWindow();
  if (w.isVisible()) w.hide(); else w.show();
}

// Toggle providers independently from the tray submenu.
function setProvider(id, enabled) {
  const key = `${id}Enabled`;
  if (!(key in cfg)) return;
  cfg[key] = enabled;
  config.save(cfg);
  rebuildTrayMenu();
  poll();
}

// Per-provider 429 cooldown + last-known-good cache, so a single rate-limit
// response doesn't blank out the widget and doesn't get hammered again before
// the server-requested (or exponentially backed-off) wait has elapsed.
const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const backoff = {};   // id -> { until, attempt }
const lastGood = {};  // id -> last provider result with ok:true

// Run one provider fetch and always resolve to a provider entry (never throw),
// so one provider being down doesn't hide the other.
async function fetchProvider(id, name, fn) {
  const now = Date.now();
  const bo = backoff[id];
  if (bo && now < bo.until) {
    const cached = lastGood[id];
    return cached
      ? { id, name, ...cached, stale: true, rateLimited: true, retryAt: bo.until }
      : { id, name, ok: false, rateLimited: true, retryAt: bo.until, error: 'rate limited' };
  }
  try {
    const r = await fn();
    delete backoff[id];
    lastGood[id] = r;
    return { id, name, ...r };
  } catch (e) {
    if (e.status === 429) {
      const attempt = (bo ? bo.attempt : 0) + 1;
      const wait = e.retryAfter
        ? e.retryAfter * 1000
        : Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (attempt - 1));
      backoff[id] = { until: now + wait, attempt };
    }
    const cached = lastGood[id];
    return cached
      ? { id, name, ...cached, stale: true, error: e.message, status: e.status || null }
      : {
        id,
        name,
        ok: false,
        error: e.message,
        status: e.status || null,
        noKey: !!e.noKey,
        noCli: !!e.noCli,
        noAuth: !!e.noAuth,
      };
  }
}

let pollInFlight = false;

// Polling deliberately does not depend on the window. History is the point of
// the log, and a hidden, closed or crashed window must not create a silent gap
// in it.
async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const jobs = [];
    if (cfg.claudeEnabled) jobs.push(fetchProvider('claude', 'Claude', () => fetchUsage()));
    if (cfg.gptEnabled) jobs.push(fetchProvider('gpt', 'GPT', () => fetchGptUsage(cfg)));
    if (cfg.zaiEnabled) jobs.push(fetchProvider('zai', 'Z.AI', () => fetchZaiUsage(cfg)));
    const providers = await Promise.all(jobs);
    // GLM Coding Plan peak window (Mon–Fri 14:00–18:00 UTC+8) is surfaced on the
    // Z.AI cell so you can see when quota is billed at 2×. Computed once per poll.
    const zai = providers.find((p) => p.id === 'zai');
    if (zai) zai.peak = getPeakState();
    // Active model is detected per-poll by reading Claude Code's newest session
    // transcript, so it tracks model switches without restarting the widget.
    const activeModel = getActiveModel();
    const payload = { providers, fetchedAt: Date.now(), activeModel, activity: getActivity() };
    lastPayload = payload;
    if (win && !win.isDestroyed()) win.webContents.send('usage-update', payload);
    // History: append this reading (and how far each meter moved) to the daily
    // log, so growth while nothing local is running can be found after the fact.
    if (cfg.loggingEnabled && logger) logger.record(payload);
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, Math.max(15, cfg.pollSeconds) * 1000);
}

// --- IPC from renderer ---
ipcMain.on('close-app', () => app.quit());
ipcMain.on('hide-app', () => { if (win && !win.isDestroyed()) win.hide(); });
ipcMain.on('refresh', () => poll(true));
ipcMain.on('set-size', (_e, { w, h }) => {
  if (!win || win.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  // Auto-size to content: width grows with the number of cells, height with rows.
  // Cap width to the work area so a long strip never spills past the screen edge.
  const targetW = Math.max(120, Math.min(wa.width - 10, Math.ceil(w)));
  const targetH = Math.max(36, Math.min(700, Math.ceil(h)));
  const [cw, ch] = win.getContentSize();
  if (cw !== targetW || ch !== targetH) win.setContentSize(targetW, targetH);
  // Re-pin the bottom-right corner after a resize.
  if (cfg.taskbarMode) reposition();
  if (process.env.CU_SHOOT && !shootTaken) {
    shootTaken = true;
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.CU_SHOOT, img.toPNG());
        console.log('SHOT saved ->', process.env.CU_SHOOT);
      } catch (e) { console.error('SHOT failed', e.message); }
    }, 600);
  }
});
ipcMain.on('set-collapsed', (_e, b) => { cfg.collapsed = !!b; config.save(cfg); });
ipcMain.handle('get-config', () => ({
  clickThrough: cfg.clickThrough,
  opacity: cfg.opacity,
  alwaysOnTop: cfg.alwaysOnTop,
  collapsed: cfg.collapsed,
}));

// Single instance — don't spawn duplicate overlays.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Launching again (desktop icon, app menu) is a request to see the widget —
  // rebuild the window if this instance lost it, rather than appearing dead.
  app.on('second-instance', () => {
    const w = ensureWindow();
    w.show();
    w.focus();
  });

  app.whenReady().then(() => {
    cfg = config.load();
    if (cfg.loggingEnabled) initLogger();
    createWindow();
    createTray();
    startPolling();
    // Keep the docked widget on the taskbar across monitor / resolution changes.
    screen.on('display-metrics-changed', () => { if (cfg.taskbarMode) reposition(); });
    // Reflect saved startup preference (XDG autostart on Linux, login item elsewhere).
    autostart.setEnabled(cfg.launchOnStartup);
    // Global hotkey to show/hide the overlay (works even when fully hidden).
    globalShortcut.register('CommandOrControl+Shift+U', () => toggleShow());
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('window-all-closed', () => {
    // Keep running in tray; do not quit on window close.
  });
}
