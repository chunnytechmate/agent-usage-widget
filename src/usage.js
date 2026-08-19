'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Read the OAuth access token fresh from disk on every call. Claude Code itself
// keeps this file's token refreshed, so by always re-reading we ride along with
// whatever valid token it maintains and never have to run the refresh flow.
function readAuth() {
  const raw = fs.readFileSync(CRED_PATH, 'utf8');
  const data = JSON.parse(raw);
  const oauth = data.claudeAiOauth || {};
  if (!oauth.accessToken) throw new Error('No accessToken in credentials file');
  return {
    token: oauth.accessToken,
    subscriptionType: oauth.subscriptionType || null,
    rateLimitTier: oauth.rateLimitTier || null,
    expiresAt: oauth.expiresAt || null,
  };
}

async function fetchUsage() {
  const auth = readAuth();
  const res = await fetch(USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'User-Agent': 'agent-usage-widget/1.0',
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Usage endpoint returned ${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 300);
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfter = retryAfter;
    throw err;
  }
  const data = await res.json();
  return normalize(data, auth);
}

// Reduce the raw response to the handful of rows the widget renders.
function normalize(data, auth) {
  const rows = [];

  if (data.five_hour && typeof data.five_hour.utilization === 'number') {
    rows.push({
      key: 'session',
      label: '5-hour session',
      percent: Math.round(data.five_hour.utilization),
      resetsAt: data.five_hour.resets_at || null,
      severity: severityFor(data.five_hour.utilization),
      compact: false,
    });
  }

  if (data.seven_day && typeof data.seven_day.utilization === 'number') {
    rows.push({
      key: 'claude-weekly',
      label: 'Claude Weekly',
      percent: Math.round(data.seven_day.utilization),
      resetsAt: data.seven_day.resets_at || null,
      severity: severityFor(data.seven_day.utilization),
      compact: true,
    });
  }

  // Per-model / scoped weekly limits (e.g. Opus, Fable) from the limits[] array.
  if (Array.isArray(data.limits)) {
    for (const lim of data.limits) {
      if (lim.kind === 'weekly_scoped' && lim.scope && lim.scope.model) {
        const name = lim.scope.model.display_name || 'model';
        rows.push({
          key: `scoped:${name}`,
          label: name,
          modelId: lim.scope.model.id || lim.scope.model.value || null,
          percent: Math.round(lim.percent || 0),
          resetsAt: lim.resets_at || null,
          severity: lim.severity || severityFor(lim.percent || 0),
          compact: true,
        });
      }
    }
  }

  return {
    ok: true,
    plan: auth.subscriptionType,
    rows,
    fetchedAt: Date.now(),
  };
}

function severityFor(pct) {
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warning';
  return 'normal';
}

module.exports = { fetchUsage, USAGE_URL };
