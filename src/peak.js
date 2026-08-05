'use strict';

// GLM Coding Plan peak-hours schedule, as published by Zhipu / BigModel:
//   高峰时段：每周一至周五的 14:00～18:00（UTC+8）
//   非高峰时段内，模型调用按基础积分消耗的 50% 抵扣
// Off-peak calls cost 50% credit; peak calls cost full credit — i.e. peak ≈
// 2× off-peak. The window is defined on the Beijing clock (UTC+8). Beijing has
// no daylight saving, so UTC+8 is a fixed +8h offset year-round, and we compute
// against it regardless of the machine's own timezone (correct while travelling
// or on a server in another zone).

const OFFSET_HOURS = 8;            // Asia/Shanghai = UTC+8, no DST
const OFFSET_MS = OFFSET_HOURS * 3600_000;
const WEEKDAYS = [1, 2, 3, 4, 5];  // Mon..Fri (getUTCDay: 0=Sun..6=Sat)
const START_MIN = 14 * 60;         // 14:00 Beijing, inclusive
const END_MIN = 18 * 60;           // 18:00 Beijing, exclusive

// Beijing wall-clock for an instant, obtained by shifting the epoch +8h and
// then reading UTC fields (purely arithmetic, no timezone DB needed).
function beijingParts(now) {
  const b = new Date(now.getTime() + OFFSET_MS);
  return {
    day: b.getUTCDay(),
    minutesOfDay: b.getUTCHours() * 60 + b.getUTCMinutes(),
    y: b.getUTCFullYear(),
    mo: b.getUTCMonth(),
    d: b.getUTCDate(),
  };
}

// True UTC instant for a Beijing wall-clock Y-M-D at H:M (Beijing H:M is UTC H:M
// minus 8h, so subtract the offset from the naive UTC construction).
function beijingInstant(y, mo, d, h, mi) {
  return Date.UTC(y, mo, d, h, mi, 0) - OFFSET_MS;
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Determine whether `now` falls inside the GLM peak window, plus the boundary
// the widget renders against (end of the current peak, or start of the next).
// Returns { active, endsAt, nextStartAt } with ISO strings (or null). Pure and
// deterministic — safe to call with any injected Date for testing.
function getPeakState(now = new Date()) {
  const force = (process.env.CU_PEAK_FORCE || '').toLowerCase();
  if (force === 'peak' || force === 'on') {
    return { active: true, endsAt: toIso(now.getTime() + 2 * 3600_000), nextStartAt: null };
  }
  if (force === 'off') {
    return { active: false, endsAt: null, nextStartAt: toIso(now.getTime() + 3600_000) };
  }

  const p = beijingParts(now);
  const isWeekday = WEEKDAYS.includes(p.day);
  const inPeak = isWeekday && p.minutesOfDay >= START_MIN && p.minutesOfDay < END_MIN;

  if (inPeak) {
    return { active: true, endsAt: toIso(beijingInstant(p.y, p.mo, p.d, 18, 0)), nextStartAt: null };
  }

  // Scan forward up to 7 days from Beijing today for the next Mon–Fri 14:00
  // that is strictly in the future (handles "past 14:00 today" and weekends).
  for (let add = 0; add <= 7; add++) {
    const ms = beijingInstant(p.y, p.mo, p.d + add, 14, 0);
    const day = new Date(ms).getUTCDay(); // 14:00 Beijing = 06:00 UTC, same calendar day
    if (WEEKDAYS.includes(day) && ms > now.getTime()) {
      return { active: false, endsAt: null, nextStartAt: toIso(ms) };
    }
  }
  return { active: false, endsAt: null, nextStartAt: null };
}

module.exports = { getPeakState };
