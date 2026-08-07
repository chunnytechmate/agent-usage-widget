'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  UsageLogger, analyze, dayKey, hourlyBuckets, lastRecord, logFileFor,
  metricKey, pruneOldLogs, readRecords, snapshotFrom, summarize, trailingRate, userDataDir,
} = require('../src/usage-log');
const { newestJsonlMtime, idleMinutesFor } = require('../src/activity');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A poll payload shaped like the one main.js sends to the renderer.
function payload({ at, claude = 10, weekly = null, gpt = null, idle = {}, activeModel = null, extra = {} }) {
  const providers = [];
  if (claude !== null) {
    const rows = [{ key: 'session', percent: claude, resetsAt: new Date(at + 4 * 3600_000).toISOString() }];
    if (weekly !== null) rows.push({ key: 'weekly', percent: weekly, resetsAt: new Date(at + 5 * 86400_000).toISOString() });
    providers.push({ id: 'claude', name: 'Claude', ok: true, rows, ...(extra.claude || {}) });
  }
  if (gpt !== null) {
    providers.push({
      id: 'gpt',
      name: 'GPT',
      ok: true,
      rows: [{ key: 'gpt:codex:primary', percent: gpt }],
      ...(extra.gpt || {}),
    });
  }
  return {
    fetchedAt: at,
    providers: providers.concat(extra.providers || []),
    activeModel: activeModel ? { label: activeModel, id: activeModel } : null,
    activity: idle,
  };
}

const T0 = Date.UTC(2026, 7, 7, 10, 0, 0);
const MIN = 60_000;

test('metric keys drop a redundant provider prefix', () => {
  assert.equal(metricKey('claude', 'session'), 'claude/session');
  assert.equal(metricKey('gpt', 'gpt:codex:primary'), 'gpt/codex:primary');
  assert.equal(metricKey('zai', 'zai-tokens'), 'zai/tokens');
});

test('snapshot flattens a poll into percentages, resets, idle times and errors', () => {
  const snap = snapshotFrom(payload({
    at: T0, claude: 41, weekly: 12, gpt: 8, activeModel: 'Fable',
    idle: { claude: 0.5, gpt: 900 },
  }));

  assert.deepEqual(snap.usage, { 'claude/session': 41, 'claude/weekly': 12, 'gpt/codex:primary': 8 });
  assert.equal(snap.active, 'Fable');
  assert.deepEqual(snap.idle, { claude: 0.5, gpt: 900 });
  assert.equal(snap.t, new Date(T0).toISOString());
  assert.ok(snap.resets['claude/session']);
  assert.equal(snap.errors, undefined);
});

test('snapshot records a failing provider without dropping the healthy one', () => {
  const snap = snapshotFrom({
    fetchedAt: T0,
    providers: [
      { id: 'claude', ok: true, rows: [{ key: 'session', percent: 5 }] },
      { id: 'gpt', ok: false, error: 'Codex CLI not found' },
      { id: 'zai', ok: false, rateLimited: true },
    ],
  });

  assert.deepEqual(snap.usage, { 'claude/session': 5 });
  assert.deepEqual(snap.errors, { gpt: 'Codex CLI not found', zai: 'rate limited' });
});

test('growth while a local agent is working raises no alert', () => {
  const prev = snapshotFrom(payload({ at: T0, claude: 20, idle: { claude: 0.2 } }));
  const curr = snapshotFrom(payload({ at: T0 + 3 * MIN, claude: 24, idle: { claude: 0.1 } }));

  const { delta, alerts } = analyze(prev, curr);
  assert.equal(delta['claude/session'], 4);
  assert.deepEqual(alerts, []);
});

test('growth with no local agent activity is flagged as an idle drain', () => {
  const prev = snapshotFrom(payload({ at: T0, claude: 20, idle: { claude: 62 } }));
  const curr = snapshotFrom(payload({ at: T0 + 3 * MIN, claude: 24, idle: { claude: 65 } }));

  const { alerts, rate } = analyze(prev, curr);
  const drain = alerts.find((a) => a.type === 'idle-drain');
  assert.ok(drain, 'expected an idle-drain alert');
  assert.equal(drain.metric, 'claude/session');
  assert.equal(drain.delta, 4);
  assert.equal(drain.level, 'warn');
  assert.equal(rate['claude/session'], 80); // 4 points in 3 min
});

test('idle drains are judged per provider, not globally', () => {
  // Codex has been cold for hours while Claude Code is busy: only the GPT meter
  // moving is suspicious.
  const idle = { claude: 0.3, gpt: 300 };
  const prev = snapshotFrom(payload({ at: T0, claude: 20, gpt: 30, idle }));
  const curr = snapshotFrom(payload({ at: T0 + 3 * MIN, claude: 25, gpt: 33, idle }));

  const drains = analyze(prev, curr).alerts.filter((a) => a.type === 'idle-drain');
  assert.deepEqual(drains.map((a) => a.metric), ['gpt/codex:primary']);
});

test('an unknown idle time is never treated as idle', () => {
  const prev = snapshotFrom(payload({ at: T0, claude: 20, idle: {} }));
  const curr = snapshotFrom(payload({ at: T0 + 3 * MIN, claude: 26, idle: {} }));

  assert.deepEqual(analyze(prev, curr).alerts.filter((a) => a.type === 'idle-drain'), []);
  assert.equal(idleMinutesFor('claude', null), null);
  assert.equal(idleMinutesFor('claude', {}), null);
  assert.equal(idleMinutesFor('zai', { claude: 40, gpt: 5 }), 5); // either agent counts
});

test('a big single-interval jump is flagged as a spike', () => {
  const prev = snapshotFrom(payload({ at: T0, claude: 20, idle: { claude: 0.1 } }));
  const curr = snapshotFrom(payload({ at: T0 + 5 * MIN, claude: 38, idle: { claude: 0.1 } }));

  const spike = analyze(prev, curr).alerts.find((a) => a.type === 'spike');
  assert.equal(spike.delta, 18);
  assert.equal(spike.minutes, 5);
});

// A steady climb: one snapshot every 3 minutes, `perStep` points each.
function climb({ from, steps, perStep, start = T0, idle = { claude: 0.1 }, resetHours = 4 }) {
  const snaps = [];
  for (let i = 0; i < steps; i++) {
    const at = start + i * 3 * MIN;
    snaps.push(snapshotFrom({
      fetchedAt: at,
      activity: idle,
      providers: [{
        id: 'claude',
        ok: true,
        rows: [{ key: 'session', percent: from + i * perStep, resetsAt: new Date(start + resetHours * 3600_000).toISOString() }],
      }],
    }));
  }
  return snaps;
}

test('a pace that empties the window before it resets is flagged', () => {
  // 30% climbing 2 points every 3 min = 40%/h, with ~4h left on the window.
  const snaps = climb({ from: 30, steps: 8, perStep: 2 });
  const curr = snaps.pop();

  const burn = analyze(snaps[snaps.length - 1], curr, {}, snaps).alerts.find((a) => a.type === 'burn-rate');
  assert.ok(burn, 'expected a burn-rate alert');
  assert.equal(burn.rate, 40);
  assert.ok(burn.projected >= 100, `projected ${burn.projected}`);
});

test('burn rate is measured over the trailing window, not one interval', () => {
  const snaps = climb({ from: 30, steps: 8, perStep: 2 });
  const curr = snaps.pop();
  const prev = snaps[snaps.length - 1];

  assert.equal(trailingRate(snaps, curr, 'claude/session', 30), 40);
  // Too little history to measure: no rate, and therefore no burn-rate alert.
  assert.equal(trailingRate(snaps.slice(-2), curr, 'claude/session', 30), null);
  assert.deepEqual(analyze(prev, curr, {}, snaps.slice(-2)).alerts.filter((a) => a.type === 'burn-rate'), []);
});

test('a window reset inside the trailing span ends the rate measurement', () => {
  const snaps = climb({ from: 90, steps: 5, perStep: 2 });
  snaps.push(...climb({ from: 2, steps: 5, perStep: 2, start: T0 + 15 * MIN }));
  const curr = snaps.pop();

  // Only the post-reset samples count, so the rate never sees the 90 -> 2 cliff.
  assert.equal(trailingRate(snaps, curr, 'claude/session', 30), 40);
});

test('a short-term pace is not projected across a multi-day window', () => {
  const snaps = climb({ from: 30, steps: 8, perStep: 2, resetHours: 24 * 5 });
  const curr = snaps.pop();

  const alerts = analyze(snaps[snaps.length - 1], curr, {}, snaps).alerts;
  assert.deepEqual(alerts.filter((a) => a.type === 'burn-rate'), []);
});

test('a falling meter is a window reset, not a drain', () => {
  const prev = snapshotFrom(payload({ at: T0, claude: 92, idle: { claude: 400 } }));
  const curr = snapshotFrom(payload({ at: T0 + 3 * MIN, claude: 3, idle: { claude: 403 } }));

  const alerts = analyze(prev, curr).alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'window-reset');
  assert.equal(alerts[0].level, 'info');
});

test('a long gap between snapshots is recorded but not blamed on one interval', () => {
  const prev = snapshotFrom(payload({ at: T0, claude: 10, idle: { claude: 500 } }));
  const curr = snapshotFrom(payload({ at: T0 + 8 * 3600_000, claude: 80, idle: { claude: 900 } }));

  const { delta, alerts } = analyze(prev, curr);
  assert.equal(delta['claude/session'], 70);
  assert.deepEqual(alerts, []);
});

test('a provider recovering from cache does not fake a spike', () => {
  const prev = snapshotFrom({
    fetchedAt: T0,
    providers: [{ id: 'zai', ok: true, stale: true, rows: [{ key: 'zai-tokens', percent: 10 }] }],
    activity: { claude: 200 },
  });
  const curr = snapshotFrom({
    fetchedAt: T0 + 3 * MIN,
    providers: [{ id: 'zai', ok: true, rows: [{ key: 'zai-tokens', percent: 55 }] }],
    activity: { claude: 203 },
  });

  const { delta, alerts } = analyze(prev, curr);
  assert.equal(delta['zai/tokens'], 45);
  assert.deepEqual(alerts, []);
});

test('provider errors are logged on change, not on every poll', () => {
  const down = snapshotFrom({ fetchedAt: T0, providers: [{ id: 'gpt', ok: false, error: 'Codex CLI not found' }] });
  const stillDown = snapshotFrom({ fetchedAt: T0 + 3 * MIN, providers: [{ id: 'gpt', ok: false, error: 'Codex CLI not found' }] });
  const up = snapshotFrom(payload({ at: T0 + 6 * MIN, claude: null, gpt: 4 }));

  assert.equal(analyze(null, down).alerts.filter((a) => a.type === 'provider-error').length, 1);
  assert.deepEqual(analyze(down, stillDown).alerts, []);
  assert.equal(analyze(stillDown, up).alerts.filter((a) => a.type === 'provider-recovered').length, 1);
});

test('logger writes on change, stays quiet when nothing moves, and heartbeats', (t) => {
  const dir = tmpDir(t);
  const log = new UsageLogger({ dir, options: { heartbeatMinutes: 15 } });

  assert.ok(log.record(payload({ at: T0, claude: 10, idle: { claude: 1 } })), 'first sample is written');
  assert.equal(log.record(payload({ at: T0 + 3 * MIN, claude: 10, idle: { claude: 1 } })), null, 'unchanged: skipped');
  assert.ok(log.record(payload({ at: T0 + 6 * MIN, claude: 13, idle: { claude: 1 } })), 'change: written');
  assert.equal(log.record(payload({ at: T0 + 9 * MIN, claude: 13, idle: { claude: 1 } })), null);
  const beat = log.record(payload({ at: T0 + 30 * MIN, claude: 13, idle: { claude: 1 } }));
  assert.ok(beat, 'heartbeat is written even with no change');
  assert.equal(beat.delta, undefined);

  const records = readRecords(dir, { days: 1, now: new Date(T0) });
  assert.equal(records.length, 3);
  assert.equal(records[1].delta['claude/session'], 3);
  // Deltas are measured against the last *observed* poll, not the last written
  // one — a skipped poll is by definition identical, so no movement is lost.
  assert.equal(records[1].deltaMin, 3);
  assert.equal(fs.existsSync(logFileFor(dir, new Date(T0))), true);
});

test('a sustained drain alerts periodically, but every delta is still recorded', (t) => {
  const dir = tmpDir(t);
  const log = new UsageLogger({ dir, options: { cooldownMinutes: { 'idle-drain': 15 } } });

  // Two hours of quota climbing 2 points every 3 min with nobody at the keyboard.
  for (let i = 0; i <= 40; i++) {
    log.record(payload({ at: T0 + i * 3 * MIN, claude: 10 + i * 2, idle: { claude: 60 + i * 3 } }));
  }

  const records = readRecords(dir, { days: 1, now: new Date(T0) });
  const drains = records.flatMap((r) => (r.alerts || []).filter((a) => a.type === 'idle-drain'));
  const gained = records.reduce((sum, r) => sum + ((r.delta && r.delta['claude/session']) || 0), 0);

  assert.equal(gained, 80, 'every point of the drain is in the log');
  assert.ok(drains.length >= 7 && drains.length <= 9, `expected ~8 alerts over 2h, got ${drains.length}`);
  const gaps = drains.slice(1).map((a, i) => (new Date(drains[i + 1].t) - new Date(drains[i].t)));
  assert.ok(drains.every((a) => a.delta === 2));
  assert.equal(summarize(records).metrics['claude/session'].idleGained, 80);
  assert.deepEqual(gaps.filter((g) => g < 15 * MIN), [], 'no two alerts closer than the cooldown');
});

test('a restarted logger picks the baseline back up from disk', (t) => {
  const dir = tmpDir(t);
  new UsageLogger({ dir }).record(payload({ at: T0, claude: 10, idle: { claude: 100 } }));

  const restarted = new UsageLogger({ dir });
  assert.equal(restarted.prev.usage['claude/session'], 10);
  const rec = restarted.record(payload({ at: T0 + 5 * MIN, claude: 17, idle: { claude: 105 } }));
  assert.equal(rec.delta['claude/session'], 7, 'delta is measured against the pre-restart sample');
  assert.ok(rec.alerts.some((a) => a.type === 'idle-drain'));
});

test('logger survives an unwritable log directory', (t) => {
  const dir = path.join(tmpDir(t), 'nested');
  fs.writeFileSync(dir, 'not a directory');
  const log = new UsageLogger({ dir });
  assert.equal(log.record(payload({ at: T0, claude: 10 })), null);
});

test('reader skips truncated lines instead of failing the file', (t) => {
  const dir = tmpDir(t);
  const file = logFileFor(dir, new Date(T0));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file,
    `${JSON.stringify({ t: new Date(T0).toISOString(), usage: { 'claude/session': 4 } })}\n` +
    '{"t":"2026-08-07T10:03:0\n' +
    `${JSON.stringify({ t: new Date(T0 + 6 * MIN).toISOString(), usage: { 'claude/session': 9 } })}\n`);

  const records = readRecords(dir, { days: 1, now: new Date(T0) });
  assert.equal(records.length, 2);
  assert.equal(lastRecord(dir).usage['claude/session'], 9);
});

test('summary totals gains across a window reset and separates the idle share', () => {
  const records = [
    { t: '2026-08-07T10:00:00.000Z', usage: { 'claude/session': 80 }, idle: { claude: 0.2 } },
    { t: '2026-08-07T10:30:00.000Z', usage: { 'claude/session': 95 }, delta: { 'claude/session': 15 }, idle: { claude: 0.2 } },
    { t: '2026-08-07T11:00:00.000Z', usage: { 'claude/session': 2 }, delta: { 'claude/session': -93 }, idle: { claude: 0.2 } },
    {
      t: '2026-08-07T11:30:00.000Z',
      usage: { 'claude/session': 12 },
      delta: { 'claude/session': 10 },
      idle: { claude: 240 },
      alerts: [{ type: 'idle-drain', level: 'warn', metric: 'claude/session', delta: 10, message: 'x' }],
    },
  ];

  const s = summarize(records);
  assert.equal(s.samples, 4);
  const m = s.metrics['claude/session'];
  assert.equal(m.first, 80);
  assert.equal(m.last, 12);
  assert.equal(m.peak, 95);
  assert.equal(m.gained, 25, 'the reset drop is not counted against the gains');
  assert.equal(m.idleGained, 10);
  assert.equal(m.resets, 1);
  assert.equal(s.alerts.length, 1);

  const hourly = hourlyBuckets(records);
  assert.deepEqual(hourly.map((b) => b.hour), ['2026-08-07T10', '2026-08-07T11']);
  assert.equal(hourly[0].gains['claude/session'], 15);
  assert.equal(hourly[1].idleGains['claude/session'], 10);
});

test('retention deletes only log files past the cutoff', (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date(T0);
  const day = (back) => dayKey(new Date(T0 - back * 86400_000));
  for (const back of [0, 1, 29, 30, 31, 45]) fs.writeFileSync(path.join(dir, `usage-${day(back)}.jsonl`), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');

  // The cutoff day itself is kept; anything older goes.
  const removed = pruneOldLogs(dir, 30, now);
  assert.deepEqual(removed.sort(), [`usage-${day(31)}.jsonl`, `usage-${day(45)}.jsonl`].sort());
  assert.equal(fs.existsSync(path.join(dir, `usage-${day(30)}.jsonl`)), true);
  assert.equal(fs.existsSync(path.join(dir, `usage-${day(29)}.jsonl`)), true);
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);
});

test('the log folder resolves per platform without Electron', () => {
  assert.equal(
    userDataDir('agent-usage-widget', 'linux', { XDG_CONFIG_HOME: '/cfg' }),
    path.join('/cfg', 'agent-usage-widget'),
  );
  assert.equal(
    userDataDir('agent-usage-widget', 'win32', { APPDATA: 'C:\\Roaming' }),
    path.join('C:\\Roaming', 'agent-usage-widget'),
  );
  assert.ok(userDataDir('agent-usage-widget', 'darwin', {}).endsWith(path.join('Application Support', 'agent-usage-widget')));
});

test('activity scan finds the newest transcript in a date-partitioned tree', (t) => {
  const root = tmpDir(t);
  const old = path.join(root, '2026', '08', '05');
  const recent = path.join(root, '2026', '08', '06');
  fs.mkdirSync(old, { recursive: true });
  fs.mkdirSync(recent, { recursive: true });
  fs.writeFileSync(path.join(old, 'rollout-a.jsonl'), '{}');
  fs.writeFileSync(path.join(recent, 'rollout-b.jsonl'), '{}');
  fs.writeFileSync(path.join(recent, 'ignore.txt'), 'x');
  fs.utimesSync(path.join(old, 'rollout-a.jsonl'), new Date(T0), new Date(T0));
  fs.utimesSync(path.join(recent, 'rollout-b.jsonl'), new Date(T0 + 3600_000), new Date(T0 + 3600_000));

  assert.equal(newestJsonlMtime(root, { depth: 4, branch: 2 }), T0 + 3600_000);
  assert.equal(newestJsonlMtime(path.join(root, 'nope'), { depth: 4 }), null);
});
