'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { idleMinutesFor } = require('./activity');

// Usage history log.
//
// Every poll is reduced to one flat snapshot — "at 13:42, Claude session was at
// 41%, weekly at 12%, GPT 5-hour at 8%" — and appended as a single JSON line to
// a daily file. Consecutive polls are compared, so each line also carries how
// much each meter moved, how fast that is per hour, and any alert the movement
// deserves.
//
// The point is the alerts. Quota that climbs while no local agent has touched a
// transcript for an hour is the signature of a leaked API key or a job left
// running somewhere you forgot about; a meter on course to hit 100% before its
// own reset is the signature of something stuck in a loop. Both are invisible in
// a live percentage and obvious in a log.
//
// Nothing sensitive is written: percentages, plan names, reset times, provider
// error messages. No tokens, no keys, no prompt content.

const LOG_FILE_RE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const LOG_DEFAULTS = {
  retentionDays: 30,     // delete daily files older than this
  heartbeatMinutes: 15,  // log an unchanged snapshot at least this often
  idleMinutes: 15,       // no transcript activity for this long => "idle"
  idleDrainPoints: 1,    // growth while idle that is worth flagging
  spikePoints: 10,       // single-interval jump that is worth flagging
  maxGapMinutes: 60,     // beyond this the gap is untrustworthy: record, don't judge
  burnWindowMinutes: 30, // trailing span a burn rate is measured over
  burnHorizonHours: 24,  // don't project a short-term rate across a longer window
  historyMinutes: 120,   // how much recent history the logger keeps for rates
  // One alert of a kind per metric per cooldown. The raw delta is still written
  // every time; this only stops a long drain from printing the same line 60×.
  cooldownMinutes: { 'idle-drain': 15, spike: 10, 'burn-rate': 30 },
};

// --- paths ---------------------------------------------------------------

// Electron's userData folder, resolved without requiring Electron so the log
// reader (`npm run log`) works from plain Node too.
function userDataDir(appName = 'agent-usage-widget', platform = process.platform, env = process.env) {
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', appName);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), appName);
}

function defaultLogDir() {
  return path.join(userDataDir(), 'logs');
}

// Local calendar day, so a log file lines up with the user's own "today".
function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function logFileFor(dir, date = new Date()) {
  return path.join(dir, `usage-${dayKey(date)}.jsonl`);
}

// --- snapshot ------------------------------------------------------------

// Stable metric name across providers: "<provider>/<row>", with the provider
// prefix some row keys already carry stripped so we never get "gpt/gpt:...".
function metricKey(providerId, rowKey) {
  const raw = String(rowKey || 'usage');
  const stripped = raw.startsWith(`${providerId}:`) ? raw.slice(providerId.length + 1)
    : raw.startsWith(`${providerId}-`) ? raw.slice(providerId.length + 1)
    : raw;
  return `${providerId}/${stripped || raw}`;
}

// Flatten one poll into the shape that gets logged.
function snapshotFrom(payload = {}) {
  const usage = {};
  const resets = {};
  const errors = {};
  const stale = [];
  const idle = {};

  for (const prov of payload.providers || []) {
    if (!prov || !prov.id) continue;
    const provIdle = idleMinutesFor(prov.id, payload.activity);
    if (provIdle !== null) idle[prov.id] = provIdle;
    if (prov.stale) stale.push(prov.id);
    if (!prov.ok) {
      errors[prov.id] = prov.rateLimited ? 'rate limited' : (prov.error || 'error');
      if (!prov.rows) continue;
    }
    for (const row of prov.rows || []) {
      if (!row || typeof row.percent !== 'number') continue;
      const key = metricKey(prov.id, row.key);
      usage[key] = Math.round(row.percent);
      if (row.resetsAt) resets[key] = toMinute(row.resetsAt);
    }
  }

  const snap = {
    t: new Date(payload.fetchedAt || Date.now()).toISOString(),
    usage,
    resets,
    idle,
  };
  const active = payload.activeModel && payload.activeModel.label;
  if (active) snap.active = active;
  if (stale.length) snap.stale = stale;
  if (Object.keys(errors).length) snap.errors = errors;
  return snap;
}

// Reset times arrive with microsecond precision that drifts on every poll
// (…:00.596944, …:00.527200). Minute precision is all a countdown or a
// projection needs, and it keeps consecutive records comparable.
function toMinute(iso) {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

function providerOf(metric) {
  const i = metric.indexOf('/');
  return i === -1 ? metric : metric.slice(0, i);
}

// --- analysis ------------------------------------------------------------

// Points-per-hour for one metric measured over the trailing `windowMin`, rather
// than over a single 3-minute interval — extrapolating one interval across a
// whole window produces nonsense ("+2% in 3 min" reads as 40%/h). Walks back
// through recent snapshots while the meter is non-decreasing, so a window reset
// inside the span ends the measurement instead of poisoning it.
// Returns null when there isn't a long enough clean span to measure.
function trailingRate(history, curr, metric, windowMin) {
  const currMs = new Date(curr.t).getTime();
  const currPct = curr.usage[metric];
  let anchor = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const snap = history[i];
    const pct = snap.usage ? snap.usage[metric] : undefined;
    if (typeof pct !== 'number') break;
    const ageMin = (currMs - new Date(snap.t).getTime()) / 60000;
    if (ageMin > windowMin) break;
    if (anchor && pct > anchor.pct) break; // meter fell going forward: window reset
    anchor = { pct, ageMin };
  }
  if (!anchor || anchor.ageMin < 10 || currPct < anchor.pct) return null;
  return Math.round(((currPct - anchor.pct) / (anchor.ageMin / 60)) * 10) / 10;
}

// Compare two consecutive snapshots: how far each meter moved, how fast, and
// what that movement is worth warning about. `history` is the recent snapshots
// before `curr` (oldest first), used only for trailing burn rates.
// Pure — no clock, no I/O.
function analyze(prev, curr, opts = {}, history = []) {
  const o = { ...LOG_DEFAULTS, ...opts };
  const delta = {};
  const rate = {};
  const alerts = [];

  const gapMin = prev ? (new Date(curr.t) - new Date(prev.t)) / 60000 : 0;
  const inWindow = !!prev && gapMin > 0 && gapMin <= o.maxGapMinutes;
  // A provider served from cache repeats its last-known value, so the jump when
  // it recovers spans an unknown stretch of time. Record the movement, don't
  // accuse anyone of it.
  const wasStale = new Set([...(prev && prev.stale) || [], ...(curr.stale || [])]);

  for (const [metric, pct] of Object.entries(curr.usage || {})) {
    const before = prev && prev.usage ? prev.usage[metric] : undefined;
    if (typeof before !== 'number') continue;
    const d = pct - before;
    if (d === 0) continue;
    delta[metric] = d;

    if (d < 0) {
      // A meter only falls when its window rolls over. Worth marking so a
      // summary can tell "reset" apart from "we lost the baseline".
      alerts.push({
        type: 'window-reset',
        level: 'info',
        metric,
        from: before,
        to: pct,
        message: `${metric} reset ${before}% -> ${pct}%`,
      });
      continue;
    }

    if (gapMin > 0) rate[metric] = Math.round((d / (gapMin / 60)) * 10) / 10;
    if (!inWindow || wasStale.has(providerOf(metric))) continue;

    const idleMin = curr.idle ? curr.idle[providerOf(metric)] : undefined;
    if (typeof idleMin === 'number' && idleMin >= o.idleMinutes && d >= o.idleDrainPoints) {
      alerts.push({
        type: 'idle-drain',
        level: 'warn',
        metric,
        delta: d,
        idleMin,
        message: `${metric} +${d}% while no local agent ran for ${Math.round(idleMin)} min`,
      });
    }

    if (d >= o.spikePoints) {
      alerts.push({
        type: 'spike',
        level: 'warn',
        metric,
        delta: d,
        minutes: Math.round(gapMin),
        message: `${metric} +${d}% in ${Math.round(gapMin)} min`,
      });
    }

    // Will this meter run out before it resets, at the pace of the last half
    // hour? Only asked of windows resetting within a day (projecting today's
    // pace across a 7-day window says nothing) and of meters actually loaded
    // enough to matter, hence the 25% floor.
    const resetsAt = curr.resets ? curr.resets[metric] : null;
    const hoursLeft = resetsAt ? (new Date(resetsAt) - new Date(curr.t)) / 3600_000 : NaN;
    const burn = trailingRate(history, curr, metric, o.burnWindowMinutes);
    if (pct >= 25 && burn > 0 && hoursLeft > 0 && hoursLeft <= o.burnHorizonHours) {
      const projected = Math.round(pct + burn * hoursLeft);
      if (projected >= 100) {
        alerts.push({
          type: 'burn-rate',
          level: 'warn',
          metric,
          rate: burn,
          projected,
          resetsAt,
          message: `${metric} at ${burn}%/h reaches ~${projected}% before it resets in ${Math.round(hoursLeft * 10) / 10}h`,
        });
      }
    }
  }

  // Provider failures are logged only when the state changes, so a Codex CLI
  // that has been missing all week doesn't fill the file with the same line.
  const prevErrors = (prev && prev.errors) || {};
  const currErrors = curr.errors || {};
  for (const [id, msg] of Object.entries(currErrors)) {
    if (prevErrors[id] === msg) continue;
    alerts.push({ type: 'provider-error', level: 'warn', provider: id, message: `${id}: ${msg}` });
  }
  for (const id of Object.keys(prevErrors)) {
    if (!currErrors[id]) {
      alerts.push({ type: 'provider-recovered', level: 'info', provider: id, message: `${id}: recovered` });
    }
  }

  return { deltaMin: prev ? Math.round(gapMin * 10) / 10 : null, delta, rate, alerts };
}

// --- writing -------------------------------------------------------------

function appendRecord(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logFileFor(dir, new Date(record.t)), `${JSON.stringify(record)}\n`);
  return record;
}

function pruneOldLogs(dir, retentionDays = LOG_DEFAULTS.retentionDays, now = new Date()) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const cutoff = dayKey(new Date(now.getTime() - retentionDays * 86400_000));
  const removed = [];
  for (const name of files) {
    const m = LOG_FILE_RE.exec(name);
    if (!m || m[1] >= cutoff) continue;
    try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch { /* keep going */ }
  }
  return removed;
}

// Stateful writer used by the app: keeps the previous snapshot in memory (and
// recovers it from disk on startup, so a restart doesn't lose the baseline and
// misattribute a whole night's growth to one interval).
class UsageLogger {
  constructor({ dir = defaultLogDir(), options = {} } = {}) {
    this.dir = dir;
    this.options = { ...LOG_DEFAULTS, ...options };
    this.prev = lastRecord(dir);
    this.lastWriteAt = this.prev ? new Date(this.prev.t).getTime() : 0;
    this.lastPruneDay = null;
    this.history = [];         // recent snapshots, for trailing burn rates
    this.alertedAt = new Map(); // "<type>:<metric>" -> ms, for alert cooldowns
  }

  setOptions(options = {}) {
    this.options = { ...this.options, ...options };
  }

  // Record one poll. Returns the written record, or null when the snapshot was
  // identical to the last one and the heartbeat isn't due yet.
  record(payload) {
    const snap = snapshotFrom(payload);
    const at = new Date(snap.t).getTime();
    const analysis = analyze(this.prev, snap, this.options, this.history);
    const alerts = this.throttle(analysis.alerts, at);

    const changed = Object.keys(analysis.delta).length > 0 || alerts.length > 0;
    const heartbeatDue = at - this.lastWriteAt >= this.options.heartbeatMinutes * 60_000;
    this.prev = snap;
    this.remember(snap, at);
    if (!changed && !heartbeatDue) return null;

    const record = { ...snap };
    if (analysis.deltaMin !== null) record.deltaMin = analysis.deltaMin;
    if (Object.keys(analysis.delta).length) record.delta = analysis.delta;
    if (Object.keys(analysis.rate).length) record.rate = analysis.rate;
    if (alerts.length) record.alerts = alerts;

    try {
      appendRecord(this.dir, record);
      this.lastWriteAt = at;
    } catch (e) {
      console.error('Failed to write usage log:', e.message);
      return null;
    }

    this.maybePrune(new Date(snap.t));
    return record;
  }

  // Keep an alert kind from repeating every poll for the whole length of a
  // drain. Types with no cooldown (window-reset, provider-*) always pass; those
  // are already edge-triggered.
  throttle(alerts, at) {
    const cooldowns = this.options.cooldownMinutes || {};
    const kept = [];
    for (const alert of alerts) {
      const minutes = cooldowns[alert.type];
      if (!minutes) { kept.push(alert); continue; }
      const key = `${alert.type}:${alert.metric || alert.provider || ''}`;
      const last = this.alertedAt.get(key);
      if (last !== undefined && at - last < minutes * 60_000) continue;
      this.alertedAt.set(key, at);
      kept.push(alert);
    }
    return kept;
  }

  // Recent snapshots, trimmed to the span trailing rates can look back over.
  remember(snap, at) {
    this.history.push(snap);
    const oldest = at - this.options.historyMinutes * 60_000;
    while (this.history.length && new Date(this.history[0].t).getTime() < oldest) this.history.shift();
  }

  // Retention runs at most once per calendar day.
  maybePrune(now) {
    const day = dayKey(now);
    if (this.lastPruneDay === day) return;
    this.lastPruneDay = day;
    pruneOldLogs(this.dir, this.options.retentionDays, now);
  }
}

// --- reading -------------------------------------------------------------

function logFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => LOG_FILE_RE.test(n)).sort().map((n) => path.join(dir, n));
}

function parseFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.t) out.push(rec);
    } catch { /* truncated write — skip the line, keep the file */ }
  }
  return out;
}

// Read records from the last `days` calendar days (1 = today), newest last.
function readRecords(dir, { days = 1, since = null, now = new Date() } = {}) {
  const cutoffDay = dayKey(new Date(now.getTime() - (Math.max(1, days) - 1) * 86400_000));
  const sinceMs = since ? new Date(since).getTime() : null;
  const records = [];
  for (const file of logFiles(dir)) {
    const m = LOG_FILE_RE.exec(path.basename(file));
    if (!m || m[1] < cutoffDay) continue;
    for (const rec of parseFile(file)) {
      if (sinceMs !== null && new Date(rec.t).getTime() < sinceMs) continue;
      records.push(rec);
    }
  }
  records.sort((a, b) => new Date(a.t) - new Date(b.t));
  return records;
}

// Roll a range of records into the per-metric answer to "how much did I burn,
// and how much of it burned while nobody was working?".
function summarize(records = []) {
  const metrics = {};
  const alerts = [];
  const errorCounts = {};

  for (const rec of records) {
    for (const [metric, pct] of Object.entries(rec.usage || {})) {
      const m = metrics[metric] || (metrics[metric] = {
        first: pct, last: pct, peak: pct, gained: 0, idleGained: 0, resets: 0, samples: 0,
      });
      m.last = pct;
      m.peak = Math.max(m.peak, pct);
      m.samples++;
      const d = rec.delta ? rec.delta[metric] : undefined;
      if (typeof d === 'number' && d > 0) {
        m.gained += d;
        const idleMin = rec.idle ? rec.idle[providerOf(metric)] : undefined;
        if (typeof idleMin === 'number' && idleMin >= LOG_DEFAULTS.idleMinutes) m.idleGained += d;
      } else if (typeof d === 'number' && d < 0) {
        m.resets++;
      }
    }
    for (const a of rec.alerts || []) {
      if (a.level === 'warn') alerts.push({ ...a, t: rec.t });
    }
    for (const id of Object.keys(rec.errors || {})) {
      errorCounts[id] = (errorCounts[id] || 0) + 1;
    }
  }

  return {
    from: records.length ? records[0].t : null,
    to: records.length ? records[records.length - 1].t : null,
    samples: records.length,
    metrics,
    alerts,
    errorCounts,
  };
}

// Per-hour gain, for the "which hours did the quota actually go?" view.
// Returns [{ hour: '2026-08-07T13', gains: {metric: pts}, idleGains: {...} }].
function hourlyBuckets(records = []) {
  const byHour = new Map();
  for (const rec of records) {
    if (!rec.delta) continue;
    const hour = rec.t.slice(0, 13);
    const bucket = byHour.get(hour) || { hour, gains: {}, idleGains: {} };
    for (const [metric, d] of Object.entries(rec.delta)) {
      if (d <= 0) continue;
      bucket.gains[metric] = (bucket.gains[metric] || 0) + d;
      const idleMin = rec.idle ? rec.idle[providerOf(metric)] : undefined;
      if (typeof idleMin === 'number' && idleMin >= LOG_DEFAULTS.idleMinutes) {
        bucket.idleGains[metric] = (bucket.idleGains[metric] || 0) + d;
      }
    }
    byHour.set(hour, bucket);
  }
  return [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

function lastRecord(dir) {
  const files = logFiles(dir);
  for (let i = files.length - 1; i >= 0; i--) {
    const recs = parseFile(files[i]);
    if (recs.length) return recs[recs.length - 1];
  }
  return null;
}

module.exports = {
  UsageLogger,
  LOG_DEFAULTS,
  analyze,
  appendRecord,
  dayKey,
  defaultLogDir,
  hourlyBuckets,
  lastRecord,
  logFileFor,
  logFiles,
  metricKey,
  pruneOldLogs,
  readRecords,
  snapshotFrom,
  summarize,
  trailingRate,
  userDataDir,
};
