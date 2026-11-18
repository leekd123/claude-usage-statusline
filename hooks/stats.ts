// The statistics page: one self-contained HTML file built from the daily JSONL logs.
// No server and no network: inline CSS, inline SVG and a script. The mod sums the logs into rows (one per
// day, project, session and model) and puts them in the page as JSON; the page's script draws the period,
// project, chart and tables from them, so changing any of those needs no rebuild.

import type { SessionRateLimit } from 'claude-code'

export type Entry = {
  day: string // the local day, from the file name
  session: string
  project: string // the session root's folder name; lines from before it was logged have none
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  turn: boolean // a main turn's end, not a response: counts a turn and nothing else
  t: string // when it was logged, ISO
  ms: number // a turn's length; 0 on a response
  title?: string // a turn's session title as of its end
}

// The page's data: the logs summed per day (d), project (p), session (s) and model (m, '' for turn lines):
// responses r, turns n, agent time ms, the four token counts, cost c, and the first and last line's time.
export type Row = {
  d: string; p: string; s: string; m: string
  r: number; n: number; ms: number; i: number; o: number; cr: number; cw: number; c: number
  f: string; l: string
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// The same as plugin.json's repository.
const REPO = 'https://github.com/leekd123/claude-usage-statusline'

export const NO_PROJECT = '(no project)'

// One file's lines; a line that is not JSON (cut off mid-write, edited by hand) is skipped.
export const parseLog = (day: string, text: string): Entry[] =>
  text.split('\n').flatMap(line => {
    try {
      const o = JSON.parse(line)
      return [{
        day,
        session: String(o.session ?? ''),
        project: String(o.project || NO_PROJECT),
        model: String(o.model ?? '?'),
        input: num(o.input),
        output: num(o.output),
        cacheRead: num(o.cacheRead),
        cacheWrite: num(o.cacheWrite),
        cost: num(o.cost),
        turn: o.turn === true,
        t: String(o.t ?? ''),
        ms: num(o.ms),
        title: typeof o.title === 'string' ? o.title : undefined,
      }]
    } catch {
      return []
    }
  })

// The rows the page draws from, and each session's title: the latest any of its turns logged.
export const rollup = (entries: Entry[]) => {
  const rows = new Map<string, Row>()
  const titles: Record<string, string> = {}
  const seen: Record<string, string> = {}
  for (const e of entries) {
    const m = e.turn ? '' : e.model
    const key = [e.day, e.project, e.session, m].join('\n')
    let r = rows.get(key)
    if (!r) rows.set(key, (r = { d: e.day, p: e.project, s: e.session, m, r: 0, n: 0, ms: 0, i: 0, o: 0, cr: 0, cw: 0, c: 0, f: e.t, l: e.t }))
    if (e.turn) {
      r.n++
      r.ms += e.ms
    } else {
      r.r++
      r.i += e.input
      r.o += e.output
      r.cr += e.cacheRead
      r.cw += e.cacheWrite
      r.c += e.cost
    }
    if (e.t && (!r.f || e.t < r.f)) r.f = e.t
    if (e.t > r.l) r.l = e.t
    if (e.title && e.t >= (seen[e.session] ?? '')) {
      titles[e.session] = e.title
      seen[e.session] = e.t
    }
  }
  return { rows: [...rows.values()].map(r => ({ ...r, c: +r.c.toFixed(6) })), titles }
}

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

const LIMIT_NAME: Record<string, string> = { five_hour: '5-hour window', seven_day: '7-day window', spend_limit: 'Spend limit' }

// One card per rate-limit window, as the last reading any session took. The page's script turns
// data-resets into a countdown, and shows 0% once the reset has passed, as the status line does.
const limitCard = (r: SessionRateLimit) =>
  `<div class="card limit" data-pct="${num(r.percentUsed)}"${r.resetsAt ? ` data-resets="${esc(r.resetsAt)}"` : ''}><div class="label">${esc(LIMIT_NAME[r.kind] ?? r.kind)}</div><div class="value pct">${num(r.percentUsed)}%</div><div class="meter"><i style="width:${Math.min(100, num(r.percentUsed))}%"></i></div><div class="sub reset">${r.resetsAt ? '' : 'no reset time reported'}</div></div>`

const limits = (rateLimits: readonly SessionRateLimit[]) =>
  rateLimits.length > 0
    ? `<div class="cards">${rateLimits.map(limitCard).join('')}</div>`
    : '<div class="note">No rate-limit reading yet. Subscription accounts get one with a session\'s first response.</div>'

// How the page was built: the time it took and what it read, to tell when reading every log gets slow.
export type Built = { ms: number; lines: number; files: number }

export const PERIODS: [number, string][] = [[1, 'Today'], [7, '7d'], [30, '30d'], [90, '90d'], [0, 'All']]
export const METRICS: [string, string][] = [['sessions', 'Sessions'], ['turns', 'Turns'], ['responses', 'Responses'], ['time', 'Agent time'], ['cost', 'Cost'], ['tokens', 'Tokens']]

const seg = (name: string, items: [string | number, string][]) =>
  `<div class="seg" role="group" aria-label="${name}">${items.map(([v, label]) => `<button data-${name}="${v}">${label}</button>`).join('')}</div>`

// A session that began before projects were logged has lines without one: they take the project its
// other lines name (the latest), so the session is not split between that project and "(no project)".
const fillProjects = (entries: Entry[]) => {
  const known: Record<string, { p: string; t: string }> = {}
  for (const e of entries) if (e.project !== NO_PROJECT && e.t >= (known[e.session]?.t ?? '')) known[e.session] = { p: e.project, t: e.t }
  return entries.map(e => (e.project === NO_PROJECT && known[e.session] ? { ...e, project: known[e.session]!.p } : e))
}

export const statsHtml = (logged: Entry[], today: string, rateLimits: readonly SessionRateLimit[] = [], built?: Built) => {
  const entries = fillProjects(logged)
  const data = { today, ...rollup(entries) }
  // Projects by their last day of use, the most recent first, each with its all-time tokens.
  const projects = new Map<string, { last: string; tokens: number }>()
  for (const e of entries) {
    const p = projects.get(e.project) ?? { last: '', tokens: 0 }
    projects.set(e.project, { last: e.day > p.last ? e.day : p.last, tokens: p.tokens + e.input + e.output + e.cacheRead + e.cacheWrite })
  }
  const order = [...projects].sort((a, b) => b[1].last.localeCompare(a[1].last) || a[0].localeCompare(b[0]))
  const all = order.reduce((n, [, p]) => n + p.tokens, 0)
  const nav = [['', 'All projects', all] as const, ...order.map(([n, p]) => [n, n, p.tokens] as const)]
    .map(([key, name, tokens]) => `<button data-project="${esc(key)}"><span>${esc(name)}</span><small>${fmt(tokens)}</small></button>`)
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude usage</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--dim:#78716c;--line:#e7e5e4;--card:#fff;--bar:#d97757;--hover:#f5f5f4;--up:#b45309;--down:#15803d}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1c1917;--fg:#f5f5f4;--dim:#a8a29e;--line:#44403c;--card:#292524;--bar:#e08a6d;--hover:#292524;--up:#fbbf24;--down:#4ade80}}
:root[data-theme=dark]{--bg:#1c1917;--fg:#f5f5f4;--dim:#a8a29e;--line:#44403c;--card:#292524;--bar:#e08a6d;--hover:#292524;--up:#fbbf24;--down:#4ade80}
:root{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
.theme,.refresh,.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.theme button,.refresh button,.seg button{font:inherit;font-size:12px;padding:4px 10px;border:0;background:var(--card);color:var(--dim);cursor:pointer}
.theme button+button,.seg button+button{border-left:1px solid var(--line)}
.theme button[aria-pressed=true],.refresh button[aria-pressed=true],.seg button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.chart{position:relative;padding-top:28px}.hit{fill:transparent}.day:hover .hit{fill:var(--hover)}
.tip{position:absolute;pointer-events:none;background:var(--fg);color:var(--bg);font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-100%)}
main{max-width:1100px;width:100%;box-sizing:border-box;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 8px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:32px 0 0}.top h2{margin:0}
.head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:32px 0 8px}.head h2{margin:0}
.note{color:var(--dim);font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.label,.sub{color:var(--dim);font-size:12px}.value{font-size:20px;font-weight:600}
.delta{font-size:12px;font-weight:500;margin-left:6px}.delta.up{color:var(--up)}.delta.down{color:var(--down)}
svg{width:100%;height:auto;display:block}svg text{fill:var(--dim);font-size:10px}
.bar{fill:var(--bar)}.none{fill:var(--line)}
.meter{height:6px;border-radius:3px;background:var(--line);margin:6px 0 4px;overflow:hidden}.meter i{display:block;height:100%;background:var(--bar)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
td.id{color:var(--dim);font-family:ui-monospace,monospace}td.empty{text-align:left;color:var(--dim)}
th:first-child,td:first-child,.two th:nth-child(2),.two td:nth-child(2){text-align:left}
.group{display:flex;gap:14px;align-items:center;color:var(--dim);font-size:12px;margin-bottom:6px}.group label{display:inline-flex;gap:4px;align-items:center;color:var(--fg);cursor:pointer}th{color:var(--dim);font-weight:500}
.app{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;box-sizing:border-box;overflow-y:auto;display:flex;flex-direction:column;padding:20px 12px;border-right:1px solid var(--line);background:var(--card)}
.side h1{font-size:16px;margin:0 8px 20px}
.side .label{margin:0 0 6px 8px}
.side nav{display:flex;flex-direction:column;gap:2px}
.side nav button{display:flex;justify-content:space-between;gap:8px;font:inherit;text-align:left;padding:6px 8px;border:0;border-radius:6px;background:none;color:var(--fg);cursor:pointer}
.side nav button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.side small{color:var(--dim)}
.side nav button:hover{background:var(--hover)}.side nav button[aria-pressed=true]{background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);font-weight:600}
.repo{color:var(--dim);font-size:12px;text-decoration:none}.repo:hover{color:var(--fg);text-decoration:underline}
.side .foot{margin-top:auto;padding:16px 8px 0;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
main>h2:first-child{margin-top:0}
@media (max-width:720px){.app{grid-template-columns:minmax(0,1fr)}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}.side nav{flex-direction:row;flex-wrap:wrap}.side .foot{margin-top:12px}}
</style></head><body><div class="app">
<aside class="side"><h1>Claude usage</h1><div class="label">Projects</div><nav aria-label="Projects">${nav}</nav>
<div class="foot"><a class="repo" href="${REPO}" target="_blank" rel="noopener noreferrer">usage-statusline on GitHub ↗</a><div class="note">Built ${esc(today)} from this machine's usage-statusline logs${built ? ` in ${built.ms} ms, ${built.lines.toLocaleString('en')} lines in ${built.files} files` : ''}.</div>
<div class="reload"><span class="refresh"><button aria-pressed="true">Auto refresh</button></span> <span class="note next"></span></div>
<div class="theme" role="group" aria-label="Theme"><button data-theme="light">Light</button><button data-theme="dark">Dark</button><button data-theme="system">System</button></div></div></aside>
<main>
<h2>Rate limits</h2>
${limits(rateLimits)}
<div class="top"><h2 id="scope"></h2>${seg('period', PERIODS)}</div>
<div class="cards" id="kpis"></div>
<div class="head"><h2 id="chart-title"></h2>${seg('metric', METRICS)}</div>
<div class="chart" id="chart"><svg role="img"></svg><div class="tip" hidden></div></div>
<h2>Breakdown</h2>
<div class="group">Group by <label><input type="checkbox" data-group="day"> Day</label><label><input type="checkbox" data-group="model"> Model</label></div>
<div class="scroll" id="breakdown"></div>
<h2>Sessions</h2>
<div class="scroll" id="sessions"></div>
<p class="note">Cost is the engine's API-price estimate, not what a subscription bills. Days are this machine's local days.</p>
</main></div>
<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>${CLIENT}</script></body></html>
`
}

// The page's script. Plain JavaScript in a raw string: no backticks and no dollar-brace inside.
const CLIENT = String.raw`
// Theme: light, dark or the system's; the choice is kept in this browser (a file:// page may refuse storage).
const root = document.documentElement
const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)) } catch {} }
const kept = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v } catch { return fallback } }
const setTheme = t => {
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t)
  for (const b of document.querySelectorAll('.theme button')) b.setAttribute('aria-pressed', String(b.dataset.theme === t))
  try { localStorage.setItem('usage-theme', t) } catch {}
}
let saved = 'system'
try { saved = localStorage.getItem('usage-theme') || 'system' } catch {}
setTheme(saved)
for (const b of document.querySelectorAll('.theme button')) b.onclick = () => setTheme(b.dataset.theme)

// Rate limits: time left to each reset.
const pad = n => String(n).padStart(2, '0')
const shortTime = d => d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
for (const card of document.querySelectorAll('.limit[data-resets]')) {
  const at = new Date(card.dataset.resets), min = Math.round((at - Date.now()) / 60000)
  const passed = min <= 0, pct = passed ? 0 : Number(card.dataset.pct)
  card.querySelector('.pct').textContent = pct + '%'
  card.querySelector('.meter i').style.width = Math.min(100, pct) + '%'
  const d = Math.floor(min / 1440), left = (d > 0 ? d + 'd ' : '') + Math.floor((min % 1440) / 60) + ':' + pad(min % 60)
  card.querySelector('.reset').textContent = passed ? 'Reset at ' + shortTime(at) + '; the next window starts with the next use' : 'Resets in ' + left + ' · ' + shortTime(at)
}

// Auto refresh: the mod rebuilds this file as usage comes in, and the page reloads each minute to pick
// that up, counting the seconds down beside the button, which turns it off and on. Every choice on the
// page is kept in the browser, and the browser keeps the scroll position.
const RELOAD_S = 60
const toggle = document.querySelector('.refresh button'), next = document.querySelector('.next')
let reload = true, left = RELOAD_S
try { reload = localStorage.getItem('usage-reload') !== 'off' } catch {}
const drawReload = () => {
  toggle.setAttribute('aria-pressed', String(reload))
  next.textContent = reload ? 'in ' + left + 's' : 'off'
}
toggle.onclick = () => {
  reload = !reload
  left = RELOAD_S
  try { localStorage.setItem('usage-reload', reload ? 'on' : 'off') } catch {}
  drawReload()
}
drawReload()
setInterval(() => {
  if (!reload) return
  if (--left <= 0) location.reload()
  else drawReload()
}, 1000)

// The data and how to read it.
const DATA = JSON.parse(document.getElementById('data').textContent)
const esc = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n)
const usd = n => '$' + n.toFixed(2)
const elapsed = ms => {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}
const tokens = x => x.i + x.o + x.cr + x.cw
const sum = rows => {
  const t = { r: 0, n: 0, ms: 0, i: 0, o: 0, cr: 0, cw: 0, c: 0, sessions: new Set() }
  for (const x of rows) {
    t.r += x.r; t.n += x.n; t.ms += x.ms; t.i += x.i; t.o += x.o; t.cr += x.cr; t.cw += x.cw; t.c += x.c
    t.sessions.add(x.s)
  }
  return t
}
const by = (rows, key) => {
  const groups = new Map()
  for (const x of rows) {
    const k = key(x)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(x)
  }
  return groups
}
const METRIC = {
  sessions: [t => t.sessions.size, String],
  turns: [t => t.n, String],
  responses: [t => t.r, String],
  time: [t => t.ms, elapsed],
  cost: [t => t.c, usd],
  tokens: [tokens, fmt],
}
const NAME = {}
for (const b of document.querySelectorAll('[data-metric]')) NAME[b.dataset.metric] = b.textContent

// Days: local calendar days as YYYY-MM-DD, the last ending today.
const shift = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const span = (from, to) => { const out = []; for (let d = from; d <= to; d = shift(d, 1)) out.push(d); return out }

// What the page shows: a project (or all), a period in days (0: all time), the chart's metric, and the
// breakdown's grouping; each kept in the browser.
let project = ''
try { project = localStorage.getItem('usage-project') || '' } catch {}
const state = { project, period: kept('usage-period', 30), metric: kept('usage-metric', 'tokens'), groups: kept('usage-groups', { day: true, model: false }) }
if (!DATA.rows.some(x => x.p === state.project)) state.project = ''
if (!METRIC[state.metric]) state.metric = 'tokens'

const draw = () => {
  const scope = state.project ? DATA.rows.filter(x => x.p === state.project) : DATA.rows
  const n = state.period
  const first = scope.reduce((m, x) => (x.d < m ? x.d : m), DATA.today)
  const days = n ? span(shift(DATA.today, 1 - n), DATA.today) : span(first, DATA.today)
  const prevDays = n ? span(shift(DATA.today, 1 - 2 * n), shift(DATA.today, -n)) : []
  const inDays = list => { const set = new Set(list); return scope.filter(x => set.has(x.d)) }
  const rows = inDays(days), cur = sum(rows), prev = sum(inDays(prevDays))
  const when = n === 1 ? 'today' : n ? 'last ' + n + ' days' : 'all time'

  document.getElementById('scope').textContent = (state.project || 'All projects') + ' · ' + when
  for (const b of document.querySelectorAll('.side nav button')) b.setAttribute('aria-pressed', String(b.dataset.project === state.project))
  for (const b of document.querySelectorAll('[data-period]')) b.setAttribute('aria-pressed', String(Number(b.dataset.period) === n))
  for (const b of document.querySelectorAll('[data-metric]')) b.setAttribute('aria-pressed', String(b.dataset.metric === state.metric))
  for (const c of document.querySelectorAll('[data-group]')) c.checked = !!state.groups[c.dataset.group]

  // One card per metric for the period, with the change from the period before it.
  document.getElementById('kpis').innerHTML = Object.keys(METRIC).map(key => {
    const [pick, show] = METRIC[key], v = pick(cur), p = pick(prev)
    const pct = p > 0 ? Math.round(((v - p) / p) * 100) : null
    const delta = pct === null ? '' : '<span class="delta ' + (pct >= 0 ? 'up' : 'down') + '">' + (pct >= 0 ? '↑' : '↓') + Math.abs(pct) + '%</span>'
    const note = pct === null ? when : 'vs previous ' + (n === 1 ? 'day' : n + ' days')
    return '<div class="card"><div class="label">' + NAME[key] + '</div><div class="value">' + show(v) + delta + '</div><div class="sub">' + note + '</div></div>'
  }).join('')

  // The chart: the metric per day over the period, a bar per day, the whole column taking the hover.
  const [pick, show] = METRIC[state.metric]
  document.getElementById('chart-title').textContent = NAME[state.metric] + ' per day, ' + when
  const perDay = by(rows, x => x.d)
  const values = days.map(d => pick(sum(perDay.get(d) || [])))
  const max = Math.max(1, ...values), W = 840, H = 160, step = W / days.length, w = Math.max(1, step * 0.8)
  const every = Math.ceil(days.length / 8)
  const svg = document.querySelector('#chart svg')
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 22))
  svg.setAttribute('aria-label', NAME[state.metric] + ' per day, ' + when)
  svg.innerHTML = days.map((d, i) => {
    const bh = Math.round((values[i] / max) * H), x = i * step
    const tip = esc(d + ' · ' + show(values[i]) + ' ' + NAME[state.metric].toLowerCase())
    const label = (days.length - 1 - i) % every === 0 ? '<text x="' + (x + step / 2) + '" y="' + (H + 16) + '" text-anchor="middle">' + d.slice(5) + '</text>' : ''
    return '<g class="day" data-tip="' + tip + '" aria-label="' + tip + '"><rect class="hit" x="' + x + '" y="0" width="' + step + '" height="' + H + '"/><rect x="' + (x + (step - w) / 2) + '" y="' + (H - bh) + '" width="' + w + '" height="' + Math.max(bh, 1) + '" rx="2" class="' + (bh ? 'bar' : 'none') + '"/>' + label + '</g>'
  }).join('')

  // The breakdown: rows grouped by day, model, both, or neither. A turn has no model, so a grouping by
  // model leaves turns and agent time out.
  const g = state.groups, byModel = g.model
  const heads = (g.day ? ['Day'] : []).concat(g.model ? ['Model'] : [])
  const base = byModel ? rows.filter(x => x.m) : rows
  let groups = g.day || g.model ? [...by(base, x => (g.day ? x.d : '') + '\n' + (g.model ? x.m : ''))] : [['', rows]]
  groups = groups.map(([k, list]) => [k ? k.split('\n').filter((_, i) => (i === 0 ? g.day : g.model)) : [n === 1 ? 'Today' : n ? 'Last ' + n + ' days' : 'All time'], sum(list)])
  groups.sort((a, b) => (g.day ? b[0][0].localeCompare(a[0][0]) : 0) || tokens(b[1]) - tokens(a[1]))
  const turnCols = !byModel
  const head = (heads.length ? heads : ['Period']).map(h => '<th>' + h + '</th>').join('') + (turnCols ? '<th>Turns</th><th>Agent time</th>' : '') + '<th>Responses</th><th>Sessions</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th><th>Cost</th>'
  const cols = 2 + heads.length + (turnCols ? 2 : 0) + 6
  const body = groups.length ? groups.map(([names, t]) => '<tr>' + names.map(x => '<td>' + esc(x) + '</td>').join('') + (turnCols ? '<td>' + t.n + '</td><td>' + elapsed(t.ms) + '</td>' : '') + '<td>' + t.r + '</td><td>' + t.sessions.size + '</td><td>' + fmt(t.i) + '</td><td>' + fmt(t.o) + '</td><td>' + fmt(t.cr) + '</td><td>' + fmt(t.cw) + '</td><td><b>' + fmt(tokens(t)) + '</b></td><td>' + usd(t.c) + '</td></tr>').join('') : '<tr><td class="empty" colspan="' + cols + '">No usage in this period.</td></tr>'
  document.getElementById('breakdown').innerHTML = '<table' + (heads.length > 1 ? ' class="two"' : '') + '><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'

  // Sessions used in the period, the most recently used first.
  const sessions = [...by(rows, x => x.s)].map(([s, list]) => {
    const t = sum(list), f = list.reduce((m, x) => (x.f && (!m || x.f < m) ? x.f : m), ''), l = list.reduce((m, x) => (x.l > m ? x.l : m), '')
    return { s, t, f, l, p: list.reduce((a, x) => (x.l >= a.l ? x : a)).p, title: DATA.titles[s] }
  }).sort((a, b) => b.l.localeCompare(a.l))
  const at = iso => (iso ? '<time datetime="' + esc(iso) + '">' + esc(shortTime(new Date(iso))) + '</time>' : '')
  document.getElementById('sessions').innerHTML = '<table class="two"><thead><tr><th>Session</th><th>Project</th><th>Started</th><th>Last used</th><th>Turns</th><th>Responses</th><th>Agent time</th><th>Total</th><th>Cost</th></tr></thead><tbody>' +
    (sessions.length ? sessions.map(x => '<tr><td' + (x.title ? '' : ' class="id"') + '>' + esc(x.title || x.s.slice(0, 8)) + '</td><td>' + esc(x.p) + '</td><td>' + at(x.f) + '</td><td>' + at(x.l) + '</td><td>' + x.t.n + '</td><td>' + x.t.r + '</td><td>' + elapsed(x.t.ms) + '</td><td><b>' + fmt(tokens(x.t)) + '</b></td><td>' + usd(x.t.c) + '</td></tr>').join('') : '<tr><td class="empty" colspan="9">No sessions in this period.</td></tr>') +
    '</tbody></table>'
}

const set = (key, value, store) => { state[key] = value; if (store) keep(store, value); draw() }
for (const b of document.querySelectorAll('.side nav button')) b.onclick = () => { try { localStorage.setItem('usage-project', b.dataset.project) } catch {} set('project', b.dataset.project) }
for (const b of document.querySelectorAll('[data-period]')) b.onclick = () => set('period', Number(b.dataset.period), 'usage-period')
for (const b of document.querySelectorAll('[data-metric]')) b.onclick = () => set('metric', b.dataset.metric, 'usage-metric')
for (const c of document.querySelectorAll('[data-group]')) c.onchange = () => set('groups', Object.assign({}, state.groups, { [c.dataset.group]: c.checked }), 'usage-groups')
draw()

// Chart tooltip: above the hovered day's column.
const chart = document.getElementById('chart'), tip = chart.querySelector('.tip')
chart.onmouseover = e => {
  const g = e.target.closest('.day')
  if (!g) return
  const c = chart.getBoundingClientRect(), r = g.querySelector('.hit').getBoundingClientRect()
  tip.textContent = g.dataset.tip
  tip.hidden = false
  const half = tip.offsetWidth / 2
  tip.style.left = Math.min(Math.max(r.left - c.left + r.width / 2, half), c.width - half) + 'px'
  tip.style.top = r.top - c.top - 4 + 'px'
}
chart.onmouseleave = () => { tip.hidden = true }
`
