'use strict';

const cellsEl = document.getElementById('cells');
const collapseBtn = document.getElementById('btn-collapse');

// Per-provider accent colors for the cell dot.
const ACCENT = { claude: '#d97757', gpt: '#10a37f', zai: '#4a8ee0' };

let lastPayload = null;
let collapsed = false;

document.getElementById('btn-refresh').addEventListener('click', () => {
  window.overlay.refresh();
});
collapseBtn.addEventListener('click', () => setCollapsed(!collapsed));

function setCollapsed(state) {
  collapsed = state;
  document.body.classList.toggle('collapsed', collapsed);
  collapseBtn.textContent = collapsed ? '⬜' : '–';
  collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
  window.overlay.setCollapsed(collapsed);
  syncSize();
}

// Apply saved collapsed state on startup.
window.overlay.getConfig().then((c) => { if (c && c.collapsed) setCollapsed(true); });

window.overlay.onUsage((payload) => {
  lastPayload = payload;
  render(payload);
});

function render(payload) {
  const providers = payload.providers || [];
  const am = payload.activeModel || null;
  cellsEl.innerHTML = '';
  renderActivePill(am);

  if (!providers.length) {
    cellsEl.innerHTML = '<div class="empty">No providers</div>';
    syncSize();
    return;
  }

  for (const prov of providers) {
    const frag = buildProviderCells(prov, am);
    if (frag) cellsEl.appendChild(frag);
  }
  syncSize();
}

// Active-model pill next to the brand. Hidden when no model could be detected.
function renderActivePill(am) {
  const pill = document.getElementById('active-pill');
  if (!pill) return;
  if (am && am.label) {
    pill.textContent = am.label;
    pill.title = 'Active model: ' + am.id;
    pill.hidden = false;
  } else {
    pill.hidden = true;
    pill.textContent = '';
  }
}

function buildProviderCells(prov, am) {
  const frag = document.createDocumentFragment();

  if (!prov.ok) {
    const msg = prov.noKey ? 'no key'
      : prov.status === 401 ? 'auth expired'
      : prov.rateLimited ? 'rate limited'
      : (prov.error || 'error');
    const cell = el('div', 'cell cell-err');
    const dot = el('span', 'cell-dot');
    dot.style.background = ACCENT[prov.id] || '#888';
    cell.appendChild(dot);
    cell.appendChild(el('span', 'cell-err-text', `${prov.name}: ${msg}`));
    if (prov.noKey) cell.title = `${prov.name}: add ZAI_API_KEY to your .env file (see README)`;
    if (prov.noCli) cell.title = 'GPT: install the Codex CLI and make sure `codex` is on PATH';
    if (prov.noAuth) cell.title = 'GPT: sign in with `codex login`';
    if (prov.rateLimited && prov.retryAt) cell.title = 'retry in ' + fmtCountdown(prov.retryAt);
    frag.appendChild(cell);
    return frag;
  }

  if (!prov.rows || !prov.rows.length) {
    const cell = el('div', 'cell cell-err');
    const dot = el('span', 'cell-dot');
    dot.style.background = ACCENT[prov.id] || '#888';
    cell.appendChild(dot);
    cell.appendChild(el('span', 'cell-err-text', `${prov.name} idle`));
    frag.appendChild(cell);
    return frag;
  }

  // Full rows get their own cell with a bar; consecutive compact rows
  // (Weekly + the per-model/Fable limit) collapse into ONE stacked cell that
  // shows only label + %, no bars — Fable sits under Weekly, and the single
  // shared reset window is shown once (Weekly's).
  let i = 0;
  while (i < prov.rows.length) {
    if (prov.rows[i].compact) {
      const group = [];
      while (i < prov.rows.length && prov.rows[i].compact) {
        group.push(prov.rows[i]);
        i++;
      }
      frag.appendChild(buildStackCell(prov, group, am));
    } else {
      frag.appendChild(buildCell(prov, prov.rows[i], am));
      i++;
    }
  }
  return frag;
}

// Stacked cell: percents only (no bars), one row per limit, with a single
// shared reset line taken from the first (Weekly) row. A row whose model matches
// the active one gets an "Active" badge.
function buildStackCell(prov, rows, am) {
  const cell = el('div', 'cell cell-stack');
  for (const r of rows) {
    const line = el('div', 'stack-row');
    const active = rowIsActive(r, am);
    if (active) line.classList.add('row-active');
    const dot = el('span', 'cell-dot');
    dot.style.background = ACCENT[prov.id] || '#888';
    line.appendChild(dot);
    line.appendChild(el('span', 'cell-label', shortLabel(r)));
    if (active) line.appendChild(el('span', 'active-badge', 'Active'));
    const pct = el('span', 'cell-pct', (r.percent || 0) + '%');
    pct.style.color = colorFor(r.severity);
    line.appendChild(pct);
    cell.appendChild(line);
  }
  const lead = rows[0];
  if (lead && lead.resetsAt) cell.appendChild(el('div', 'cell-reset', fmtReset(lead.resetsAt)));
  return cell;
}

function buildCell(prov, row, am) {
  const cell = el('div', 'cell');
  const active = rowIsActive(row, am);
  if (active) cell.classList.add('is-active');

  // GLM Coding Plan peak window (attached only to the Z.AI provider). While
  // active, the bar/dot go amber and the reset line becomes a peak countdown;
  // the quota reset moves to the tooltip so it isn't lost.
  const peak = prov.peak || null;
  const peakActive = !!(peak && peak.active);
  if (peakActive) cell.classList.add('is-peak');

  const head = el('div', 'cell-head');
  const dot = el('span', 'cell-dot');
  dot.style.background = peakActive ? 'var(--warning)' : (ACCENT[prov.id] || '#888');
  head.appendChild(dot);
  head.appendChild(el('span', 'cell-label', shortLabel(row)));
  if (active) head.appendChild(el('span', 'active-badge', 'Active'));
  const pct = el('span', 'cell-pct', (row.percent || 0) + '%');
  pct.style.color = peakActive ? 'var(--warning)' : colorFor(row.severity);
  head.appendChild(pct);
  cell.appendChild(head);

  const bar = el('div', 'bar');
  const fill = el('div', 'bar-fill ' + (row.severity || 'normal'));
  fill.style.width = Math.min(100, row.percent || 0) + '%';
  bar.appendChild(fill);
  cell.appendChild(bar);

  if (peakActive && peak.endsAt) {
    cell.appendChild(el('div', 'cell-reset', fmtPeak(peak.endsAt)));
    if (row.resetsAt) cell.title = `${prov.name} quota ${fmtReset(row.resetsAt)}`;
  } else {
    if (row.resetsAt) cell.appendChild(el('div', 'cell-reset', fmtReset(row.resetsAt)));
    if (peak && peak.nextStartAt) {
      const np = fmtNextPeak(peak.nextStartAt);
      cell.title = cell.title ? `${cell.title} · ${np}` : np;
    }
  }
  return cell;
}

function shortLabel(row) {
  if (row.key === 'session') return 'Session';
  if (row.key === 'claude-weekly') return 'Claude Weekly';
  if (row.key === 'zai-tokens') return 'Z.AI';
  if (row.key.startsWith('gpt:')) return row.label === 'Usage' ? 'GPT' : `GPT ${row.label}`;
  if (row.key.startsWith('scoped:')) return row.label;  // model name, e.g. Fable
  return row.label;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function colorFor(sev) {
  return sev === 'critical' ? 'var(--critical)'
    : sev === 'warning' ? 'var(--warning)'
    : 'var(--normal)';
}

// Does this usage row correspond to the currently-active model? Match on the
// friendly label first (most reliable), then on a normalized id (suffix-stripped).
function rowIsActive(row, am) {
  if (!am || !am.label) return false;
  if (row.label && row.label === am.label) return true;
  if (row.modelId && am.norm && normId(row.modelId) === am.norm) return true;
  return false;
}

function normId(id) {
  return String(id || '')
    .toLowerCase()
    .replace(/\[.*?\]$/, '')
    .replace(/-1m$/, '')
    .trim();
}

// Reference-style reset: "reset 22:10 (50min)" same day,
// "reset Thu 08:59 (4d 19h)" another day, or "reset soon".
function fmtReset(iso) {
  if (!iso) return '';
  const target = new Date(iso);
  const now = new Date();
  const secs = Math.floor((target - now) / 1000);
  if (secs <= 0) return 'reset soon';
  const totalH = Math.floor(secs / 3600);
  const totalM = Math.floor((secs % 3600) / 60);
  let cd;
  if (totalH >= 48)      cd = `${Math.floor(totalH / 24)}d ${totalH % 24}h`;
  else if (totalH > 0)   cd = `${totalH}h ${String(totalM).padStart(2, '0')}min`;
  else                   cd = `${totalM}min`;
  const time = target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = target.getDate() === now.getDate()
    && target.getMonth() === now.getMonth()
    && target.getFullYear() === now.getFullYear();
  if (sameDay) return `reset ${time} (${cd})`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `reset ${days[target.getDay()]} ${time} (${cd})`;
}

// GLM peak countdown for the reset line: "peak · 2× · ends 17:00 (2h 15min)".
// Countdown is recomputed from endsAt on every render, so it stays fresh between
// polls (the renderer re-renders every 30s).
function fmtPeak(endsAt) {
  if (!endsAt) return 'peak · 2×';
  const target = new Date(endsAt);
  const now = new Date();
  const secs = Math.max(0, Math.floor((target - now) / 1000));
  const totalH = Math.floor(secs / 3600);
  const totalM = Math.floor((secs % 3600) / 60);
  const cd = totalH > 0
    ? `${totalH}h ${String(totalM).padStart(2, '0')}min`
    : `${totalM}min`;
  const time = target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `peak · 2× · ends ${time} (${cd})`;
}

// Next peak start for the cell tooltip: "next GLM peak Mon 13:00".
function fmtNextPeak(nextStartAt) {
  if (!nextStartAt) return '';
  const target = new Date(nextStartAt);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const time = target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `next GLM peak ${days[target.getDay()]} ${time}`;
}

// Compact countdown for error tooltips ("1h 30m"). Accepts an ISO string or epoch ms.
function fmtCountdown(isoOrMs) {
  const diff = new Date(isoOrMs).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return 'now';
  const mins = Math.floor(diff / 60000);
  const days = Math.floor(mins / 1440);
  const hrs = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${m}m`;
  return `${m}m`;
}

function syncSize() {
  requestAnimationFrame(() => {
    const widget = document.querySelector('.widget');
    if (!widget) return;
    // .widget is width:max-content, so offsetWidth/Height are its true intrinsic
    // size regardless of the window's current width. Add margin + a little slack
    // so nothing at the right edge (buttons / Z.AI reset) is clipped.
    const w = Math.max(widget.offsetWidth, widget.scrollWidth) + 16;
    const h = Math.max(widget.offsetHeight, widget.scrollHeight) + 16;
    window.overlay.setSize(w, h);
  });
}

// Re-render periodically so the reset countdowns stay fresh between polls.
setInterval(() => { if (lastPayload) render(lastPayload); }, 30000);
