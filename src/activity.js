'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// "Is a local agent actually working right now?" — answered by looking at the
// session transcripts each CLI writes while it runs. Quota that climbs while
// every transcript is cold is quota nobody at this keyboard asked for: a leaked
// key, a forgotten background job, or a session left running somewhere else.
//
// Claude Code:  ~/.claude/projects/<project>/<session>.jsonl
// Codex CLI:    ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

// Newest mtime of any *.jsonl below `dir`, walking at most `depth` levels.
// `branch` caps how many subdirectories are visited per level (newest name
// first) — the Codex tree is date-partitioned, so the two newest names are all
// that can hold a live session, even across a midnight rollover.
function newestJsonlMtime(dir, { depth = 1, branch = Infinity } = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

  let best = null;
  const dirs = [];
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (depth > 1) dirs.push(ent.name);
      continue;
    }
    if (!ent.name.endsWith('.jsonl')) continue;
    let st;
    try { st = fs.statSync(path.join(dir, ent.name)); } catch { continue; }
    if (best === null || st.mtimeMs > best) best = st.mtimeMs;
  }

  if (depth > 1 && dirs.length) {
    dirs.sort().reverse();
    for (const name of dirs.slice(0, branch)) {
      const sub = newestJsonlMtime(path.join(dir, name), { depth: depth - 1, branch });
      if (sub !== null && (best === null || sub > best)) best = sub;
    }
  }
  return best;
}

// Minutes since each local agent last wrote to a session transcript.
// A value of null means "unknown" (CLI never used / directory unreadable), and
// callers must treat unknown as "can't judge", never as "idle".
function getActivity(now = Date.now()) {
  const claudeMs = newestJsonlMtime(CLAUDE_PROJECTS, { depth: 2 });
  const codexMs = newestJsonlMtime(CODEX_SESSIONS, { depth: 4, branch: 2 });
  return {
    claude: toIdleMinutes(claudeMs, now),
    gpt: toIdleMinutes(codexMs, now),
  };
}

function toIdleMinutes(mtimeMs, now) {
  if (!Number.isFinite(mtimeMs)) return null;
  return Math.max(0, Math.round(((now - mtimeMs) / 60000) * 10) / 10);
}

// Which transcript speaks for a given provider?
//   claude -> Claude Code   gpt -> Codex CLI
//   zai    -> either, since GLM is usually driven through one of them; taking
//             the smaller idle time is the conservative choice (fewer false
//             "nobody is working" alarms).
function idleMinutesFor(providerId, activity) {
  if (!activity) return null;
  if (providerId === 'gpt') return nullable(activity.gpt);
  if (providerId === 'claude') return nullable(activity.claude);
  const known = [activity.claude, activity.gpt].filter((n) => Number.isFinite(n));
  return known.length ? Math.min(...known) : null;
}

function nullable(n) {
  return Number.isFinite(n) ? n : null;
}

module.exports = { getActivity, idleMinutesFor, newestJsonlMtime, CLAUDE_PROJECTS, CODEX_SESSIONS };
