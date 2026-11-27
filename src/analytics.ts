import { db } from './db';
import { sync, syncEnabled, syncConfig } from './sync';
import { activityRows, idleSeconds, trackingEnabled } from './activity-store';
import { ACTIVITY_KINDS, COUNTERS, activeMs, dayKey, emptyCounts, emptyTimes, type ActivityBucket } from './activity';
import { folderContains, folderPaths } from './folders';
import { download, h, icon, iconBtn, toast } from './ui';

const names = { writing: 'Writing', highlighting: 'Highlighting', erasing: 'Erasing', editing: 'Editing & selecting', navigation: 'Scrolling & zooming', reading: 'Reading / thinking', idle: 'Idle', away: 'Away' };
const counterNames = { opens: 'Notebook opens', pageViews: 'Page visits', pageSwitches: 'Page changes', awaySwitches: 'Switched away', returns: 'Returns', focusStarts: 'Focus bursts', strokes: 'Pen contacts', highlights: 'Highlights', erasures: 'Eraser gestures', selections: 'Lasso selections', transforms: 'Moves / resizes', undos: 'Undo', redos: 'Redo', zooms: 'Zoom gestures', scrolls: 'Scroll / pan gestures', characters: 'Typed characters' };
const duration = (ms: number) => ms < 60_000 ? `${ms > 0 && ms < 1000 ? (ms / 1000).toFixed(1) : Math.floor(ms / 1000)}s` : ms < 3600_000 ? `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s` : `${Math.floor(ms / 3600_000)}h ${Math.floor(ms / 60_000) % 60}m`;
function sum(rows: ActivityBucket[]) {
  const ms = emptyTimes(), counts = emptyCounts();
  for (const b of rows) { for (const k of ACTIVITY_KINDS) ms[k] += b.ms[k]; for (const k of COUNTERS) counts[k] += b.counts[k]; }
  return { ms, counts, active: activeMs({ ms }), open: Object.values(ms).reduce((n, v) => n + v, 0) };
}
function localDate(day: string) { return new Date(day + 'T12:00:00'); }
function dateLabel(day: string) { return localDate(day).toLocaleDateString([], { day: 'numeric', month: 'short' }); }
function daysBetween(from: string, to: string) {
  const days: string[] = [], d = localDate(from), end = localDate(to);
  while (d <= end && days.length < 3660) { days.push(dayKey(+d)); d.setDate(d.getDate() + 1); }
  return days;
}

export async function showAnalytics(root: HTMLElement) {
  let all: ActivityBucket[] = [];
  try { all = await activityRows(); } catch { toast('Analytics storage could not be read. Your notes are unaffected.'); }
  const notebooks = await db.notebooks(), notebookMap = new Map(notebooks.map(n => [n.id, n]));
  const today = dayKey(Date.now());
  const first = new Date(); first.setDate(first.getDate() - 29);
  const from = h('input', { class: 'field', type: 'date', value: dayKey(+first), 'aria-label': 'From date' });
  const to = h('input', { class: 'field', type: 'date', value: today, 'aria-label': 'To date' });
  const folder = h('select', { class: 'field', 'aria-label': 'Analytics folder' }, h('option', { value: '*' }, 'All folders'),
    ...folderPaths([...notebooks.map(n => n.folder), ...all.map(b => b.folder)]).map(f => h('option', { value: f }, f)), h('option', { value: '' }, 'Unfiled'));
  const notebook = h('select', { class: 'field', 'aria-label': 'Analytics notebook' });
  const page = h('select', { class: 'field', 'aria-label': 'Analytics page' });
  const group = h('select', { class: 'field', 'aria-label': 'Group statistics by' }, ...[['folder', 'Folders'], ['notebook', 'Notebooks'], ['page', 'Pages']].map(([value, label]) => h('option', { value }, label)));
  const sort = h('select', { class: 'field', 'aria-label': 'Sort statistics by' }, ...[['active', 'Active time'], ['writing', 'Writing time'], ['strokes', 'Pen strokes'], ['away', 'Switches away']].map(([value, label]) => h('option', { value }, label)));
  const result = h('div', { class: 'analytics-results', 'aria-live': 'polite' });
  const syncStatus = h('span', { class: 'hint' });
  const syncButton = h('button', { class: 'btn small', type: 'button', disabled: !syncEnabled(), onclick: async () => {
    syncButton.disabled = true; syncStatus.textContent = 'Syncing…';
    try { await sync(); all = await activityRows(); notebookOptions(); render(); syncStatus.textContent = syncConfig().error || 'Synced'; }
    catch { syncStatus.textContent = 'Could not sync. Local statistics are kept.'; }
    finally { syncButton.disabled = !syncEnabled(); }
  } }, 'Sync');
  syncStatus.textContent = syncEnabled() ? (syncConfig().error || 'Private sync enabled') : 'Local only · set up Sync in the library';
  const statsBody = h('div', { class: 'analytics-breakdown' });
  function contextFolder(b: ActivityBucket) { return notebookMap.get(b.notebook)?.folder ?? b.folder; }
  function eligible(b: ActivityBucket) { return folder.value === '*' || folder.value === '' ? folder.value === '*' || contextFolder(b) === '' : folderContains(folder.value, contextFolder(b)); }
  function notebookOptions() {
    const ids = new Set(all.filter(eligible).map(b => b.notebook));
    for (const n of notebooks) if (folder.value === '*' || (folder.value === '' ? !n.folder : folderContains(folder.value, n.folder))) ids.add(n.id);
    notebook.replaceChildren(h('option', { value: '*' }, 'All notebooks'), ...[...ids].sort((a, b) => title(a).localeCompare(title(b))).map(id => h('option', { value: id }, title(id))));
    pageOptions();
  }
  function title(id: string) { return notebookMap.get(id)?.title ?? all.find(b => b.notebook === id)?.title ?? 'Deleted notebook'; }
  function pageOptions() {
    const selected = notebookMap.get(notebook.value);
    const ids = selected?.pages ?? [...new Set(all.filter(b => b.notebook === notebook.value).map(b => b.page))];
    page.replaceChildren(h('option', { value: '*' }, 'All pages'), ...ids.map((id, i) => h('option', { value: id }, `Page ${i + 1}`)));
    page.disabled = notebook.value === '*';
  }
  function selectedRows() {
    return all.filter(b => b.day >= from.value && b.day <= to.value && eligible(b) && (notebook.value === '*' || b.notebook === notebook.value) && (page.value === '*' || b.page === page.value));
  }
  function exportData(csv: boolean) {
    const rows = selectedRows();
    if (!csv) { download(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, buckets: rows }, null, 2)], { type: 'application/json' }), 'Opplinotes analytics.json'); return; }
    const cols = ['day', 'start', 'end', 'folder', 'notebook', 'page', ...ACTIVITY_KINDS.map(k => k + '_seconds'), ...COUNTERS];
    // Quote and neutralise spreadsheet formula prefixes in user-controlled titles/folders.
    const cell = (v: unknown) => '"' + String(v).replace(/^[=+@\-\t\r]/, x => "'" + x).replace(/"/g, '""') + '"';
    const lines = rows.map(b => [b.day, new Date(b.start).toISOString(), new Date(b.end).toISOString(), contextFolder(b), title(b.notebook), notebookMap.get(b.notebook)?.pages.indexOf(b.page)! + 1 || b.pageNumber, ...ACTIVITY_KINDS.map(k => (b.ms[k] / 1000).toFixed(3)), ...COUNTERS.map(k => b.counts[k])].map(cell).join(','));
    download(new Blob(['\uFEFF' + [cols.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'Opplinotes analytics.csv');
  }
  const enabled = h('input', { type: 'checkbox', checked: trackingEnabled(), onchange: () => { localStorage.setItem('opplinotes.analytics.enabled', enabled.checked ? 'on' : 'off'); toast(enabled.checked ? 'Tracking starts when you open a notebook.' : 'Tracking paused. Existing statistics are kept.'); } });
  const idle = h('select', { class: 'field', 'aria-label': 'Idle timeout', onchange: () => localStorage.setItem('opplinotes.analytics.idle', idle.value) }, ...[15, 30, 60, 120].map(n => h('option', { value: n, selected: n === idleSeconds() }, n + ' seconds')));
  const presets = h('div', { class: 'analytics-presets', role: 'group', 'aria-label': 'Date presets' }, ...[['Today', 1], ['7 days', 7], ['30 days', 30], ['All time', 0]].map(([label, days]) => h('button', { class: 'btn small', type: 'button', onclick: () => { const d = new Date(); d.setDate(d.getDate() - (Number(days) - 1)); from.value = days ? dayKey(+d) : all.reduce((s, b) => b.day < s ? b.day : s, today); to.value = today; render(); } }, String(label))));
  root.replaceChildren(h('main', { class: 'analytics' },
    h('header', { class: 'analytics-head' }, h('div', { class: 'row' }, iconBtn('back', 'Back to library', () => { location.hash = ''; }), h('span', { class: 'analytics-brand' }, 'Opplinotes / Analytics')),
      h('div', { class: 'row' }, syncStatus, syncButton, h('button', { class: 'btn small', onclick: () => exportData(true) }, 'Export CSV'), h('button', { class: 'btn small', onclick: () => exportData(false) }, 'Export JSON'))),
    h('section', { class: 'analytics-intro' }, h('span', { class: 'analytics-eyebrow' }, 'YOUR STUDY RHYTHM'), h('h1', null, 'Make your time count.'), h('p', null, 'Your focus, from the big picture down to a single page.')),
    h('section', { class: 'analytics-filters', 'aria-label': 'Analytics filters' }, presets, h('div', { class: 'analytics-filter-grid' }, h('label', null, 'From', from), h('label', null, 'To', to), h('label', null, 'Folder', folder), h('label', null, 'Notebook', notebook), h('label', null, 'Page', page))),
    result,
    h('section', { class: 'analytics-card' }, h('div', { class: 'analytics-section-head' }, h('h2', null, 'Where your time goes'), h('div', { class: 'row' }, group, sort)), statsBody),
    h('details', { class: 'analytics-card analytics-method' }, h('summary', null, 'Tracking & privacy'),
      h('label', { class: 'check' }, enabled, h('span', null, 'Track study activity on this device')),
      h('label', { class: 'row' }, 'Count idle after', idle),
      h('p', null, 'Writing and highlighting estimate actual contact time, not the whole time a tool is selected. Editing includes lasso, moving, resizing and typing. Navigation measures scrolling, panning and zooming. A short, input-free gap is estimated reading / thinking time; after the idle limit it is excluded from active time. Mouse movement and pen hover do not keep you active.'),
      h('p', null, 'Changing windows or hiding the tab immediately counts as away. Sleep and long timer gaps count as idle. Open time includes active, idle and away time while a notebook is open. Focus bursts restart after idle or a switch away. Gesture counters describe input attempts, including edits later undone; they do not count the objects remaining on a page. Wheel events separated by less than 600 ms form one gesture.'),
      h('p', null, 'Local and offline, from now on. No retroactive estimates. When Sync is configured, analytics use the same private server and secret as your notes. Otherwise they stay on this browser/device. Notebook backup files do not include analytics. Exports contain identifiers, folder names, notebook titles, dates and aggregate counters; never handwriting, coordinates or typed text. Folder reports use the notebook’s current folder; deleted notebooks retain their last recorded name/folder. Synced copies of the same session are merged without counting twice. Multiple windows each record their own open/away time; active time requires window focus.'))));
  folder.addEventListener('change', () => { notebookOptions(); render(); });
  notebook.addEventListener('change', () => { pageOptions(); render(); });
  for (const e of [from, to, page, group, sort]) e.addEventListener('change', render);
  notebookOptions(); render();

  function render() {
    if (!from.value || !to.value || from.value > to.value) { result.replaceChildren(h('p', { class: 'analytics-empty' }, 'Choose a valid date range.')); statsBody.replaceChildren(); return; }
    const rows = selectedRows(), s = sum(rows), days = daysBetween(from.value, to.value);
    const daily = new Map<string, ActivityBucket[]>();
    for (const b of rows) { const a = daily.get(b.day) ?? []; a.push(b); daily.set(b.day, a); }
    const activeDays = [...daily.values()].filter(r => sum(r).active > 0).length;
    const focusedOpen = s.open - s.ms.away;
    const card = (label: string, value: string, detail: string) => h('article', { class: 'analytics-stat' }, h('span', null, label), h('strong', null, value), h('small', null, detail));
    const previousStart = localDate(from.value); previousStart.setDate(previousStart.getDate() - days.length);
    const previousEnd = localDate(from.value); previousEnd.setDate(previousEnd.getDate() - 1);
    const prev = sum(all.filter(b => b.day >= dayKey(+previousStart) && b.day <= dayKey(+previousEnd) && eligible(b) && (notebook.value === '*' || b.notebook === notebook.value) && (page.value === '*' || b.page === page.value))).active;
    const delta = prev ? `${s.active >= prev ? '+' : ''}${Math.round((s.active - prev) / prev * 100)}% vs previous ${days.length} days` : 'No earlier activity to compare';
    const cards = h('div', { class: 'analytics-stats' }, card('Active study', duration(s.active), delta), card('Pen on page', duration(s.ms.writing + s.ms.highlighting), `${s.counts.strokes.toLocaleString()} strokes · ${s.counts.highlights.toLocaleString()} highlights`), card('Idle + away excluded', duration(s.ms.idle + s.ms.away), `${duration(s.open)} total open time`), card('Focus ratio', focusedOpen ? Math.round(s.active / focusedOpen * 100) + '%' : '—', 'Active / foreground time'));
    const dailyMax = Math.max(1, ...[...daily.values()].map(r => sum(r).active));
    const chartDays = days.slice(-90);
    const dailyChart = h('div', { class: 'analytics-daily', 'aria-label': 'Daily active study time' }, ...chartDays.map(day => {
      const a = sum(daily.get(day) ?? []), label = `${day}: ${duration(a.active)} active, ${duration(a.ms.writing + a.ms.highlighting)} writing`;
      return h('button', { class: 'analytics-day', title: label, 'aria-label': label, onclick: () => { from.value = to.value = day; render(); } }, h('span', { class: 'analytics-day-bar', style: { height: `${Math.max(1, a.active / dailyMax * 100)}%` } }, h('span', { style: { height: `${a.active ? (a.ms.writing + a.ms.highlighting) / a.active * 100 : 0}%` } })), h('small', null, dateLabel(day)));
    }));
    const activity = h('div', { class: 'analytics-composition' }, ...ACTIVITY_KINDS.map(k => h('div', { class: 'analytics-kind' }, h('div', { class: 'row' }, h('span', { class: 'activity-dot kind-' + k }), h('span', null, names[k]), h('strong', null, duration(s.ms[k]))), h('div', { class: 'analytics-track' }, h('i', { class: 'kind-' + k, style: { width: `${s.open ? s.ms[k] / s.open * 100 : 0}%` } })))));
    let streak = 0, bestStreak = 0;
    for (const d of days) { streak = sum(daily.get(d) ?? []).active > 0 ? streak + 1 : 0; bestStreak = Math.max(streak, bestStreak); }
    const insights = h('div', { class: 'analytics-insights' }, card('Study days', String(activeDays), `${duration(activeDays ? s.active / activeDays : 0)} per active day`), card('Best streak', bestStreak + ' days', 'Consecutive days in this range'), card('Focus bursts', String(s.counts.focusStarts), `${duration(s.counts.focusStarts ? s.active / s.counts.focusStarts : 0)} active time per burst`), card('Switched away', String(s.counts.awaySwitches), `${s.counts.returns} returns · ${s.counts.pageSwitches} page changes`));
    const hours = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const b of rows) { const d = new Date(b.minute); hours[(d.getDay() + 6) % 7][d.getHours()] += activeMs(b); }
    const peak = Math.max(1, ...hours.flat());
    const heatmap = h('div', { class: 'analytics-heatmap', 'aria-label': 'Activity by weekday and hour, local time' }, h('span'), ...Array.from({ length: 24 }, (_, hour) => h('small', null, hour % 3 === 0 ? String(hour).padStart(2, '0') : '')), ...hours.flatMap((hourly, day) => [h('small', null, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][day]), ...hourly.map((v, hour) => h('span', { class: 'analytics-heat-cell', title: `${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][day]} ${hour}:00 — ${duration(v)} active`, style: { background: v ? `color-mix(in srgb, var(--a9) ${15 + v / peak * 85}%, var(--n3))` : 'var(--n3)' } }))]));
    const sessions = new Map<string, ActivityBucket[]>();
    for (const b of rows) { const key = b.session + b.day; const a = sessions.get(key) ?? []; a.push(b); sessions.set(key, a); }
    const recent = [...sessions.values()].sort((a, b) => Math.max(...b.map(r => r.end)) - Math.max(...a.map(r => r.end))).slice(0, 50);
    const sessionList = h('div', { class: 'analytics-table-wrap' }, h('table', { class: 'analytics-table' }, h('thead', null, h('tr', null, ...['Date & time', 'Notebook', 'Active', 'Writing', 'Idle / away', 'Switches'].map(t => h('th', null, t)))), h('tbody', null, ...recent.map(r => {
      const a = sum(r), start = Math.min(...r.map(b => b.start)), end = Math.max(...r.map(b => b.end));
      const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return h('tr', null, h('td', null, `${dateLabel(r[0].day)} ${time(start)}–${time(end)}`), h('td', null, title(r[0].notebook)), h('td', null, duration(a.active)), h('td', null, duration(a.ms.writing + a.ms.highlighting)), h('td', null, duration(a.ms.idle + a.ms.away)), h('td', null, String(a.counts.awaySwitches)));
    }))));
    result.replaceChildren(!all.length ? h('div', { class: 'analytics-empty' }, icon('analytics', 36), h('h2', null, 'Your next session starts the story.'), h('p', null, 'Open a notebook and write, read or move around. Your first statistics will appear here.')) : !rows.length ? h('p', { class: 'analytics-empty' }, 'No activity matches these filters.') : h('span', { hidden: true }),
      cards, h('div', { class: 'analytics-two-col' }, h('section', { class: 'analytics-card' }, h('div', { class: 'analytics-section-head' }, h('h2', null, 'Daily rhythm'), h('small', null, chartDays.length < days.length ? 'Last 90 days of selected range' : 'Click a day to explore')), dailyChart), h('section', { class: 'analytics-card' }, h('h2', null, 'Time, honestly counted'), activity)),
      insights, h('section', { class: 'analytics-card' }, h('h2', null, 'When you find your flow'), h('p', { class: 'hint' }, 'Active time by weekday and hour · local time'), heatmap),
      h('details', { class: 'analytics-card' }, h('summary', null, 'All activity counters'), h('div', { class: 'analytics-counters' }, ...COUNTERS.map(k => h('div', null, h('span', null, counterNames[k]), h('strong', null, s.counts[k].toLocaleString()))))),
      h('details', { class: 'analytics-card' }, h('summary', null, `Session history · ${sessions.size} sessions`), sessionList));
    renderBreakdown(rows);
  }
  function renderBreakdown(rows: ActivityBucket[]) {
    const groups = new Map<string, ActivityBucket[]>();
    for (const b of rows) { const key = group.value === 'folder' ? contextFolder(b) : group.value === 'notebook' ? b.notebook : b.notebook + '\n' + b.page; const a = groups.get(key) ?? []; a.push(b); groups.set(key, a); }
    const ranked = [...groups].map(([key, rows]) => ({ key, rows, ...sum(rows) })).sort((a, b) => sort.value === 'writing' ? b.ms.writing + b.ms.highlighting - a.ms.writing - a.ms.highlighting : sort.value === 'strokes' ? b.counts.strokes - a.counts.strokes : sort.value === 'away' ? b.counts.awaySwitches - a.counts.awaySwitches : b.active - a.active);
    const max = Math.max(1, ...ranked.map(r => r.active));
    const body = h('tbody', null, ...ranked.map(r => {
      const b = r.rows[0], nb = notebookMap.get(b.notebook);
      const label = group.value === 'folder' ? r.key || 'Unfiled' : group.value === 'notebook' ? title(b.notebook) : `${title(b.notebook)} · Page ${nb && nb.pages.includes(b.page) ? nb.pages.indexOf(b.page) + 1 : b.pageNumber}`;
      return h('tr', null, h('td', null, h('button', { class: 'analytics-drill', onclick: () => { if (group.value === 'folder') { folder.value = r.key; notebookOptions(); group.value = 'notebook'; } else { notebook.value = b.notebook; pageOptions(); if (group.value === 'page') page.value = b.page; group.value = 'page'; } render(); } }, label), h('div', { class: 'analytics-track' }, h('i', { style: { width: `${r.active / max * 100}%` } }))), h('td', null, duration(r.active)), h('td', null, duration(r.ms.writing + r.ms.highlighting)), h('td', null, duration(r.ms.navigation)), h('td', null, duration(r.ms.idle + r.ms.away)), h('td', null, String(r.counts.strokes)), h('td', null, String(r.counts.awaySwitches)));
    }));
    statsBody.replaceChildren(ranked.length ? h('div', { class: 'analytics-table-wrap' }, h('table', { class: 'analytics-table' }, h('thead', null, h('tr', null, ...[group.value === 'folder' ? 'Folder' : group.value === 'notebook' ? 'Notebook' : 'Page', 'Active', 'Writing', 'Navigation', 'Idle / away', 'Strokes', 'Switches'].map(t => h('th', null, t)))), body)) : h('p', { class: 'hint' }, 'No activity yet. Your notes are ready when you are.'));
  }
}
