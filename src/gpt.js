'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const { resolveCodexCommand } = require('./codex-path');

const REQUEST_TIMEOUT_MS = 15_000;

// Ask the locally installed Codex CLI for the ChatGPT/Codex rate-limit view.
// Codex owns OAuth token storage and refresh; this widget never reads or sends
// the token itself. The app-server protocol is newline-delimited JSON-RPC.
function fetchGptUsage(cfg = {}) {
  const command = resolveCodexCommand(cfg);

  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    let stderr = '';

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (!child.killed) child.kill();
      if (err) reject(err); else resolve(result);
    };

    const send = (message) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const timer = setTimeout(() => {
      const err = new Error('Codex usage request timed out');
      err.code = 'CODEX_TIMEOUT';
      finish(err);
    }, REQUEST_TIMEOUT_MS);

    child.on('error', (cause) => {
      const err = new Error(cause.code === 'ENOENT'
        ? 'Codex CLI not found'
        : `Could not start Codex CLI: ${cause.message}`);
      err.code = cause.code;
      err.noCli = cause.code === 'ENOENT';
      finish(err);
    });

    child.stderr.on('data', (chunk) => {
      // Keep only a small diagnostic tail. Codex app-server does not print
      // credentials, but this is never forwarded unless the process fails.
      stderr = (stderr + chunk.toString()).slice(-500);
    });

    child.on('exit', (code) => {
      if (settled) return;
      const detail = stderr.trim().split(/\r?\n/).pop();
      finish(new Error(detail || `Codex app-server exited with code ${code}`));
    });

    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }

      if (message.id === 0) {
        if (message.error) {
          finish(rpcError(message.error));
          return;
        }
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1 });
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          finish(rpcError(message.error));
          return;
        }
        finish(null, normalize(message.result || {}));
      }
    });

    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'agent_usage_widget',
          title: 'Agent Usage Widget',
          version: '1.0.0',
        },
      },
    });
  });
}

function rpcError(data) {
  const message = data && data.message ? data.message : 'Codex app-server request failed';
  const err = new Error(message);
  err.status = data && data.code;
  err.noAuth = /auth|log[ -]?in|credential/i.test(message);
  return err;
}

function normalize(result) {
  const byId = result.rateLimitsByLimitId;
  const limits = byId && typeof byId === 'object' && Object.keys(byId).length
    ? Object.values(byId)
    : (result.rateLimits ? [result.rateLimits] : []);
  const rows = [];

  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') continue;
    for (const slot of ['primary', 'secondary']) {
      const window = limit[slot];
      if (!window || typeof window.usedPercent !== 'number') continue;
      const percent = Math.round(window.usedPercent);
      rows.push({
        key: `gpt:${limit.limitId || 'codex'}:${slot}`,
        label: limitLabel(limit, window, slot),
        percent,
        resetsAt: secondsToIso(window.resetsAt),
        severity: severityFor(percent),
        compact: false,
      });
    }
  }

  const first = limits[0] || {};
  return {
    ok: true,
    plan: first.planType || null,
    credits: first.credits || null,
    rows,
    fetchedAt: Date.now(),
  };
}

function limitLabel(limit, window, slot) {
  const mins = Number(window.windowDurationMins);
  let windowName;
  if (mins === 10080) windowName = 'Weekly';
  else if (mins === 1440) windowName = 'Daily';
  else if (mins > 0 && mins % 1440 === 0) windowName = `${mins / 1440}-day`;
  else if (mins > 0 && mins % 60 === 0) windowName = `${mins / 60}-hour`;
  else if (mins > 0) windowName = `${mins}-min`;
  else windowName = slot === 'primary' ? 'Usage' : 'Secondary';

  const id = limit.limitId || 'codex';
  const rawName = limit.limitName;
  if (!rawName || id === 'codex' || rawName === 'codex') return windowName;
  const bucket = String(rawName).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${bucket} ${windowName}`;
}

function secondsToIso(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function severityFor(pct) {
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warning';
  return 'normal';
}

module.exports = { fetchGptUsage, normalize };
