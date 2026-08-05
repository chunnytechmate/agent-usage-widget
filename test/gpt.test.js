'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalize } = require('../src/gpt');
const { resolveCodexCommand } = require('../src/codex-path');

test('normalizes primary and secondary Codex windows', () => {
  const result = normalize({
    rateLimits: {
      limitId: 'codex',
      planType: 'plus',
      primary: { usedPercent: 21.6, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 45.2, windowDurationMins: 10080, resetsAt: 1_800_100_000 },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan, 'plus');
  assert.deepEqual(result.rows.map((row) => ({ key: row.key, label: row.label, percent: row.percent })), [
    { key: 'gpt:codex:primary', label: '5-hour', percent: 22 },
    { key: 'gpt:codex:secondary', label: 'Weekly', percent: 45 },
  ]);
  assert.equal(result.rows[0].resetsAt, '2027-01-15T08:00:00.000Z');
});

test('prefers the multi-bucket rate limit response without duplicating the legacy view', () => {
  const result = normalize({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 99, windowDurationMins: 60, resetsAt: 1_800_000_000 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
      },
      codex_other: {
        limitId: 'codex_other',
        limitName: 'review_limit',
        primary: { usedPercent: 75, windowDurationMins: 1440, resetsAt: 1_800_000_000 },
      },
    },
  });

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].label, 'Weekly');
  assert.equal(result.rows[1].label, 'Review Limit Daily');
  assert.equal(result.rows[1].severity, 'warning');
});

test('returns an idle provider when no rate-limit windows are available', () => {
  assert.deepEqual(normalize({}).rows, []);
});

test('resolves Codex installed under NVM when GUI PATH is minimal', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-path-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const olderBin = path.join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin');
  const currentBin = path.join(home, '.nvm', 'versions', 'node', 'v24.2.0', 'bin');
  fs.mkdirSync(olderBin, { recursive: true });
  fs.mkdirSync(currentBin, { recursive: true });
  fs.writeFileSync(path.join(olderBin, 'codex'), '');
  fs.writeFileSync(path.join(currentBin, 'codex'), '');
  fs.chmodSync(path.join(olderBin, 'codex'), 0o755);
  fs.chmodSync(path.join(currentBin, 'codex'), 0o755);

  assert.equal(resolveCodexCommand({}, {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    platform: 'linux',
    home,
  }), path.join(currentBin, 'codex'));
});

test('Codex path override takes precedence over automatic discovery', () => {
  assert.equal(resolveCodexCommand({ codexPath: '/opt/codex' }, {
    env: { CODEX_BIN: '/env/codex' },
    platform: 'linux',
    home: '/unused',
  }), '/opt/codex');
});
