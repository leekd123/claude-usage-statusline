// The statistics page: stats.html, the page's code, and data.js beside it, built from the daily JSONL logs.
// No server and no network: inline CSS, inline SVG and a script. The mod sums the logs into rows (one per
// day, project, session and model) and writes them to data.js; the page's script draws the period,
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

// The page's data: the logs summed per day (d), local hour (h), project (p), session (s) and model (m, '' for turn lines):
// responses r, turns n, agent time ms, the four token counts, cost c, and the first and last line's time.
export type Row = {
  d: string; h: number; p: string; s: string; m: string
  r: number; n: number; ms: number; i: number; o: number; cr: number; cw: number; c: number
  f: string; l: string
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// The same as plugin.json's repository.
const REPO = 'https://github.com/leekd123/claude-usage-statusline'

export const NO_PROJECT = '(no project)'

// One file's lines; a line that is not JSON (cut off mid-write, edited by hand) is skipped, and so is a
// rate-limit reading, which parseLimits reads.
export const parseLog = (day: string, text: string): Entry[] =>
  text.split('\n').flatMap(line => {
    try {
      const o = JSON.parse(line)
      if (Array.isArray(o.limits)) return []
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

// A rate-limit reading, logged when the shared one changes: [time, kind, percent used, reset time or ''].
export type Reading = [string, string, number, string]
export const parseLimits = (text: string): Reading[] =>
  text.split('\n').flatMap(line => {
    if (!line.includes('"limits"')) return []
    try {
      const o = JSON.parse(line)
      return Array.isArray(o.limits) ? o.limits.map((r: Record<string, unknown>): Reading => [String(o.t ?? ''), String(r.kind ?? ''), num(r.percent), String(r.resetsAt ?? '')]) : []
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
    // The local half hour (13.5: 13:30), in the zone that named the day's file; the chart's finest step.
    const at = new Date(e.t), h = e.t ? at.getHours() + (at.getMinutes() >= 30 ? 0.5 : 0) || 0 : 0
    const key = [e.day, h, e.project, e.session, m].join('\n')
    let r = rows.get(key)
    if (!r) rows.set(key, (r = { d: e.day, h, p: e.project, s: e.session, m, r: 0, n: 0, ms: 0, i: 0, o: 0, cr: 0, cw: 0, c: 0, f: e.t, l: e.t }))
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

// How the page was built: the time it took and what it read, to tell when reading every log gets slow.
export type Built = { ms: number; lines: number; files: number }

export const PERIODS: [number, string][] = [[1, 'Today'], [3, '3d'], [7, '7d'], [14, '14d'], [30, '30d'], [90, '90d'], [0, 'All']]
// The chart's step in hours; 0 picks one for the period.
export const STEPS: [number, string][] = [[0, 'Auto'], [0.5, '30m'], [1, '1h'], [2, '2h'], [3, '3h'], [4, '4h'], [6, '6h'], [12, '12h'], [24, '24h']]
export const METRICS: [string, string][] = [['sessions', 'Sessions'], ['turns', 'Turns'], ['responses', 'Responses'], ['time', 'Agent time'], ['cost', 'Cost'], ['tokens', 'Tokens']]

const seg = (name: string, items: [string | number, string][]) =>
  `<div class="seg" role="group" aria-label="${name}">${items.map(([v, label]) => `<button data-${name}="${v}">${label}</button>`).join('')}</div>`

// A session that began before projects were logged has lines without one: they take the project its
// other lines name (the latest), so the session is not split between that project and "(no project)";
// a session none of whose lines names one takes the project its transcript gave, if any.
const fillProjects = (entries: Entry[], info: Record<string, SessionInfo>) => {
  const known: Record<string, { p: string; t: string }> = {}
  for (const e of entries) if (e.project !== NO_PROJECT && e.t >= (known[e.session]?.t ?? '')) known[e.session] = { p: e.project, t: e.t }
  return entries.map(e => {
    const p = (e.project === NO_PROJECT ? (known[e.session]?.p ?? info[e.session]?.project) : undefined) ?? e.project
    return { ...e, project: SCRATCH.test(p) ? SCRATCH_PROJECT : p }
  })
}

// The desktop app's own folders for a conversation with no folder picked (scratch-<day>-<id>), and the
// pre-started sessions it keeps under ~/.claude/spares (spare-<id>): one each, so they are shown as one project.
const SCRATCH = /^(scratch-\d{4}-\d{2}-\d{2}-[0-9a-z]+|spare-[0-9A-Za-z]{6})$/
export const SCRATCH_PROJECT = '(scratch)'

// What a session's transcript gave for one the logs name no title or project for.
export type SessionInfo = { title?: string; project?: string }

// What data.js carries. VERSION changes only when this shape does; a page meeting another asks for a reload.
export const VERSION = 2

// `page`: when stats.html was last written; an open page that sees it change reloads whole for the new code.
export const statsData = (logged: Entry[], today: string, rateLimits: readonly SessionRateLimit[] = [], built?: Built, info: Record<string, SessionInfo> = {}, page = 0, history: Reading[] = []) => {
  const entries = fillProjects(logged, info)
  const data = { version: VERSION, page, today, ...rollup(entries), limits: rateLimits, history: [...history].sort((a, b) => a[0].localeCompare(b[0])), built: built ?? null, projects: [] as [string, number][] }
  for (const [session, i] of Object.entries(info)) if (i.title && !data.titles[session]) data.titles[session] = i.title
  // Projects by their last day of use, the most recent first, each with its all-time tokens.
  const projects = new Map<string, { last: string; tokens: number }>()
  for (const e of entries) {
    const p = projects.get(e.project) ?? { last: '', tokens: 0 }
    projects.set(e.project, { last: e.day > p.last ? e.day : p.last, tokens: p.tokens + e.input + e.output + e.cacheRead + e.cacheWrite })
  }
  data.projects = [...projects].sort((a, b) => b[1].last.localeCompare(a[1].last) || a[0].localeCompare(b[0])).map(([n, p]) => [n, p.tokens])
  return data
}

// data.js: a script, not JSON, since a file:// page may load a script beside it but not fetch a file.
// `<` is escaped so no text in the data can end a script.
export const statsScript = (data: ReturnType<typeof statsData>) => `window.USAGE = ${JSON.stringify(data).replace(/</g, '\\u003c')}\n`

// What the page shows until its script has drawn from data.js: the same boxes, empty, so nothing moves
// when the figures arrive (two rate-limit windows, as subscriptions report).
const PLACEHOLDER_LIMITS = `<div class="cards">${'<div class="card limit"><div class="label">&nbsp;</div><div class="value pct">—</div><div class="meter"><i style="width:0"></i></div><div class="sub reset">&nbsp;</div></div>'.repeat(2)}</div>`
const PLACEHOLDER_KPIS = METRICS.map(([, label]) => `<div class="card"><div class="label">${label}</div><div class="value">—</div><div class="sub">&nbsp;</div></div>`).join('')

// The page's code: the same for every build, so the mod writes it only at session start.
export const statsPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude usage</title>
<script>try { const t = localStorage.getItem('usage-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t) } catch {} // the chosen theme before the first paint, so a reload never flashes the other one</script>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--dim:#78716c;--line:#e7e5e4;--card:#fff;--bar:#d97757;--bar2:#2563eb;--hover:#f5f5f4;--up:#b45309;--down:#15803d}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1c1917;--fg:#f5f5f4;--dim:#a8a29e;--line:#44403c;--card:#292524;--bar:#e08a6d;--bar2:#60a5fa;--hover:#292524;--up:#fbbf24;--down:#4ade80}}
:root[data-theme=dark]{--bg:#1c1917;--fg:#f5f5f4;--dim:#a8a29e;--line:#44403c;--card:#292524;--bar:#e08a6d;--bar2:#60a5fa;--hover:#292524;--up:#fbbf24;--down:#4ade80}
:root{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
.every{font:inherit;font-size:12px;padding:3px 4px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
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
svg{width:100%;height:auto;display:block}.chart svg{aspect-ratio:840/182}#breakdown,#sessions{min-height:120px}svg text{fill:var(--dim);font-size:10px}
.line{fill:none;stroke:var(--bar);stroke-width:2;stroke-linejoin:round;pointer-events:none}.area{fill:var(--bar);opacity:.15;pointer-events:none}.grid{stroke:var(--line);pointer-events:none}.axis{pointer-events:none}.dot{fill:var(--bar);opacity:0}.lim{fill:none;stroke-width:2}.legend{display:flex;gap:14px;color:var(--dim);font-size:12px}.legend i{display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}.day:hover .dot{opacity:1}
.meter{height:6px;border-radius:3px;background:var(--line);margin:6px 0 4px;overflow:hidden}.meter i{display:block;height:100%;background:var(--bar)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
td.id{color:var(--dim);font-family:ui-monospace,monospace}td.empty{text-align:left;color:var(--dim)}
th:first-child,td:first-child,.two th:nth-child(2),.two td:nth-child(2){text-align:left}
.group{display:flex;gap:14px;align-items:center;color:var(--dim);font-size:12px;margin-bottom:6px}.group label{display:inline-flex;gap:4px;align-items:center;color:var(--fg);cursor:pointer}th{color:var(--dim);font-weight:500}
.app{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:100vh}
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
<aside class="side"><h1>Claude usage</h1><div class="label">Projects</div><nav aria-label="Projects" id="nav"><button data-project="" aria-pressed="true"><span>All projects</span><small>—</small></button></nav>
<div class="foot"><a class="repo" href="${REPO}" target="_blank" rel="noopener noreferrer">usage-statusline on GitHub ↗</a><div class="note" id="built">&nbsp;</div>
<div class="reload"><span class="refresh"><button aria-pressed="true">Auto refresh</button></span> <select class="every" aria-label="Refresh every"><option value="5">5s</option><option value="10">10s</option><option value="15">15s</option><option value="30">30s</option><option value="60">1m</option><option value="300">5m</option><option value="900">15m</option></select> <span class="note next"></span></div>
<div class="theme" role="group" aria-label="Theme"><button data-theme="light">Light</button><button data-theme="dark">Dark</button><button data-theme="system">System</button></div></div></aside>
<main>
<h2>Rate limits</h2>
<div id="limits">${PLACEHOLDER_LIMITS}</div>
<div class="top"><h2 id="scope">&nbsp;</h2>${seg('period', PERIODS)}</div>
<div class="cards" id="kpis">${PLACEHOLDER_KPIS}</div>
<div class="head"><h2 id="chart-title">&nbsp;</h2>${seg('step', STEPS)}${seg('metric', METRICS)}</div>
<div class="chart" id="chart"><svg role="img"></svg><div class="tip" hidden></div></div>
<div class="head"><h2>Rate limit usage</h2><div class="legend" id="limit-legend"></div></div>
<div class="chart" id="limit-chart"><svg role="img"></svg></div>
<h2>Breakdown</h2>
<div class="group">Group by <label><input type="checkbox" data-group="day"> Day</label><label><input type="checkbox" data-group="model"> Model</label></div>
<div class="scroll" id="breakdown"></div>
<h2>Sessions</h2>
<div class="scroll" id="sessions"></div>
<p class="note">Cost is the engine's API-price estimate, not what a subscription bills. Days are this machine's local days.</p>
</main></div>
<script src="data.js"></script>
<script>${CLIENT}</script></body></html>
`

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
// Auto refresh: the mod rebuilds data.js as usage comes in, and the page loads it again every so often (a
// minute unless chosen) to pick that up, counting down beside the button, which turns it off and on.
// Every choice on the page is kept in the browser, and the browser keeps the scroll position.
const toggle = document.querySelector('.refresh button'), next = document.querySelector('.next'), every = document.querySelector('.every')
const EVERY = [...every.options].map(o => Number(o.value))
let reload = true, period = EVERY.includes(kept('usage-reload-s', 60)) ? kept('usage-reload-s', 60) : 60, left = period
every.value = String(period)
try { reload = localStorage.getItem('usage-reload') !== 'off' } catch {}
const drawReload = () => {
  toggle.setAttribute('aria-pressed', String(reload))
  next.textContent = reload ? 'in ' + (left < 60 ? left + 's' : Math.floor(left / 60) + ':' + pad(left % 60)) : 'off'
}
toggle.onclick = () => {
  reload = !reload
  left = period
  try { localStorage.setItem('usage-reload', reload ? 'on' : 'off') } catch {}
  drawReload()
}
every.onchange = () => {
  period = left = Number(every.value)
  keep('usage-reload-s', period)
  drawReload()
}
// Each refresh loads data.js again and redraws in place, so nothing flashes. The whole page reloads only
// when it has to: data.js names a newer stats.html, has another shape, or was missing at first.
const refresh = () => {
  const s = document.createElement('script')
  s.src = 'data.js?' + Date.now()
  s.onload = s.onerror = () => {
    s.remove()
    const d = window.USAGE
    if (!d || d === DATA) return // not there, or cut off mid-write: try again next time
    if (!DATA || DATA.version !== ${VERSION} || d.version !== DATA.version || d.page !== DATA.page) location.reload()
    else { DATA = d; render() }
  }
  document.head.appendChild(s)
}
drawReload()
setInterval(() => {
  if (!reload) return
  if (--left <= 0) { left = period; refresh() }
  drawReload()
}, 1000)

// The data and how to read it. data.js is rewritten as usage comes in; a page that finds none, or one
// of a shape it does not know (a session on other code wrote it), says so and draws nothing more.
let DATA = window.USAGE
const esc = s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')
const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n)
if (!DATA || DATA.version !== ${VERSION}) {
  document.querySelector('main').innerHTML = '<p class="note">' + (DATA ? 'This page and its data.js come from different versions of usage-statusline. Run /reload-plugins in a Claude Code session to rebuild both.' : 'No data.js next to this page yet. Run /usage-stats in a Claude Code session.') + '</p>'
  throw new Error('usage-statusline: no usable data.js')
}

// Projects, with each one's all-time tokens, and how the data was built.
const drawSide = () => {
  document.getElementById('nav').innerHTML = [['', 'All projects', DATA.projects.reduce((n, p) => n + p[1], 0)]].concat(DATA.projects.map(p => [p[0], p[0], p[1]]))
    .map(p => '<button data-project="' + esc(p[0]) + '"><span>' + esc(p[1]) + '</span><small>' + fmt(p[2]) + '</small></button>').join('')
  const b = DATA.built
  document.getElementById('built').textContent = 'Built ' + DATA.today + " from this machine's usage-statusline logs" + (b ? ' in ' + b.ms + ' ms, ' + b.lines.toLocaleString('en') + ' lines in ' + b.files + ' files' : '') + '.'
}

// Rate limits: one card per window, as the last reading any session took, with the time left to its
// reset; 0% once the reset has passed, as the status line shows.
const LIMIT_NAME = { five_hour: '5-hour window', seven_day: '7-day window', spend_limit: 'Spend limit' }
const num = v => (typeof v === 'number' && isFinite(v) ? v : 0)
const drawLimits = () => document.getElementById('limits').innerHTML = DATA.limits.length === 0
  ? '<div class="note">No rate-limit reading yet. Subscription accounts get one with a session' + "'" + 's first response.</div>'
  : '<div class="cards">' + DATA.limits.map(r => {
    const at = r.resetsAt ? new Date(r.resetsAt) : null, min = at ? Math.round((at - Date.now()) / 60000) : 0
    const passed = at && min <= 0, pct = passed ? 0 : num(r.percentUsed)
    const d = Math.floor(min / 1440), left = (d > 0 ? d + 'd ' : '') + Math.floor((min % 1440) / 60) + ':' + pad(min % 60)
    const reset = !at ? 'no reset time reported' : passed ? 'Reset at ' + shortTime(at) + '; the next window starts with the next use' : 'Resets in ' + left + ' · ' + shortTime(at)
    return '<div class="card limit"><div class="label">' + esc(LIMIT_NAME[r.kind] || r.kind) + '</div><div class="value pct">' + pct + '%</div><div class="meter"><i style="width:' + Math.min(100, pct) + '%"></i></div><div class="sub reset">' + esc(reset) + '</div></div>'
  }).join('') + '</div>'
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
const state = { project, period: kept('usage-period', 30), metric: kept('usage-metric', 'tokens'), step: kept('usage-step', 0), groups: kept('usage-groups', { day: true, model: false }) }
if (!DATA.rows.some(x => x.p === state.project)) state.project = ''
if (!METRIC[state.metric]) state.metric = 'tokens'
if (![0, 0.5, 1, 2, 3, 4, 6, 12, 24].includes(state.step)) state.step = 0

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
  for (const b of document.querySelectorAll('[data-step]')) b.setAttribute('aria-pressed', String(Number(b.dataset.step) === state.step))
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

  // The chart: the metric over the period as a line, in buckets of the chosen step or, on Auto, one sized
  // to the period (an hour for today, 2 hours for 3 days, 3 for 7, 6 for 14, 12 for 30, a day beyond), each bucket's column taking the hover. Buckets yet to come are left out.
  const [pick, show] = METRIC[state.metric]
  const size = state.step || (n === 1 ? 1 : n === 3 ? 2 : n === 7 ? 3 : n === 14 ? 6 : n === 30 ? 12 : 24)
  const per = size === 0.5 ? 'per 30 minutes' : size === 1 ? 'per hour' : size === 24 ? 'per day' : 'per ' + size + ' hours'
  const hm = h => pad(Math.floor(h)) + (h % 1 ? ':30' : ':00')
  document.getElementById('chart-title').textContent = NAME[state.metric] + ' ' + per + ', ' + when
  const perBucket = by(rows, x => x.d + ' ' + (x.h - (x.h % size)))
  const now = Date.now()
  const buckets = days.flatMap(d => Array.from({ length: 24 / size }, (_, k) => ({ d, h: k * size })))
    .filter(b => new Date(b.d + 'T' + hm(b.h)).getTime() <= now)
  const values = buckets.map(b => pick(sum(perBucket.get(b.d + ' ' + b.h) || [])))
  const max = Math.max(1, ...values), W = 840, H = 160, step = W / Math.max(1, buckets.length)
  const px = i => i * step + step / 2, py = v => H - (v / max) * (H - 6)
  // Labels: the hours on a single day, otherwise the days' starts; about 8 at most, the last always shown.
  const marks = buckets.map((b, i) => i).filter(i => days.length === 1 || buckets[i].h === 0)
  const every = Math.ceil(marks.length / 8), shown = new Set(marks.filter((_, k) => (marks.length - 1 - k) % every === 0))
  const svg = document.querySelector('#chart svg')
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 22))
  svg.setAttribute('aria-label', NAME[state.metric] + ' ' + per + ', ' + when)
  const grid = [1, 0.5].map(f => '<line class="grid" x1="0" x2="' + W + '" y1="' + py(max * f) + '" y2="' + py(max * f) + '"/><text class="axis" x="2" y="' + (py(max * f) + 12) + '">' + esc(show(max * f)) + '</text>').join('') + '<line class="grid" x1="0" x2="' + W + '" y1="' + H + '" y2="' + H + '"/>'
  const columns = buckets.map((b, i) => {
    const at = size === 24 ? b.d : b.d + ' ' + hm(b.h) + '–' + hm(b.h + size)
    const tip = esc(at + ' · ' + show(values[i]) + ' ' + NAME[state.metric].toLowerCase())
    const label = shown.has(i) ? '<text x="' + px(i) + '" y="' + (H + 16) + '" text-anchor="middle">' + (days.length === 1 ? hm(b.h) : b.d.slice(5)) + '</text>' : ''
    return '<g class="day" data-tip="' + tip + '" aria-label="' + tip + '"><rect class="hit" x="' + i * step + '" y="0" width="' + step + '" height="' + H + '"/><circle class="dot" cx="' + px(i) + '" cy="' + py(values[i]) + '" r="3.5"/>' + label + '</g>'
  }).join('')
  const pts = values.map((v, i) => px(i).toFixed(1) + ',' + py(v).toFixed(1))
  const line = pts.length ? '<path class="area" d="M' + px(0) + ',' + H + 'L' + pts.join('L') + 'L' + px(pts.length - 1) + ',' + H + 'Z"/><path class="line" d="M' + pts.join('L') + '"/>' : ''
  svg.innerHTML = columns + grid + line // the grid over the columns, so a hovered column does not hide its labels

  // Rate limits over the period: each window's percent as last read, held until the next reading, and 0
  // from a reset that passed before it. They are the account's, so the project choice does not apply.
  const start = new Date(days[0] + 'T00:00').getTime(), end = Math.max(start + 1, now)
  const hist = (DATA.history || []).filter(r => Date.parse(r[0]) <= end)
  const lx = t => ((t - start) / (end - start)) * W, ly = p => H - (Math.min(p, 100) / 100) * (H - 6)
  const series = kind => {
    const pts = []
    let reset = 0
    for (const r of hist) if (r[1] === kind) {
      const t = Date.parse(r[0])
      if (reset && reset < t) pts.push([reset, 0])
      pts.push([t, r[2]])
      reset = r[3] ? Date.parse(r[3]) : 0
    }
    if (reset && reset < end) pts.push([reset, 0])
    const before = pts.filter(p => p[0] < start).at(-1), inside = pts.filter(p => p[0] >= start)
    return before ? [[start, before[1]]].concat(inside) : inside
  }
  const kinds = Object.keys(LIMIT_NAME).concat([...new Set(hist.map(r => r[1]))]).filter((k, i, all) => all.indexOf(k) === i && hist.some(r => r[1] === k))
  const COLOR = ['var(--bar)', 'var(--bar2)', 'var(--dim)']
  const lsvg = document.querySelector('#limit-chart svg')
  lsvg.setAttribute('viewBox', '0 0 ' + W + ' ' + (H + 22))
  lsvg.setAttribute('aria-label', 'Rate limit usage, ' + when)
  const lgrid = [100, 50].map(p => '<line class="grid" x1="0" x2="' + W + '" y1="' + ly(p) + '" y2="' + ly(p) + '"/><text class="axis" x="2" y="' + (ly(p) + 12) + '">' + p + '%</text>').join('') + '<line class="grid" x1="0" x2="' + W + '" y1="' + H + '" y2="' + H + '"/>'
  const ticks = [...shown].map(i => '<text x="' + lx(new Date(buckets[i].d + 'T' + hm(buckets[i].h)).getTime()) + '" y="' + (H + 16) + '" text-anchor="middle">' + (days.length === 1 ? hm(buckets[i].h) : buckets[i].d.slice(5)) + '</text>').join('')
  const lines = kinds.map((k, n) => {
    const pts = series(k), color = COLOR[Math.min(n, COLOR.length - 1)]
    if (!pts.length) return ''
    const d = 'M' + lx(pts[0][0]).toFixed(1) + ',' + ly(pts[0][1]).toFixed(1) + pts.slice(1).map(p => 'H' + lx(p[0]).toFixed(1) + 'V' + ly(p[1]).toFixed(1)).join('') + 'H' + W
    const dots = hist.filter(r => r[1] === k && Date.parse(r[0]) >= start).map(r => '<circle class="reading" cx="' + lx(Date.parse(r[0])).toFixed(1) + '" cy="' + ly(r[2]).toFixed(1) + '" r="2.5" style="fill:' + color + '"><title>' + esc(shortTime(new Date(r[0])) + ' · ' + (LIMIT_NAME[k] || k) + ' ' + r[2] + '%') + '</title></circle>').join('')
    return '<path class="lim" style="stroke:' + color + '" d="' + d + '"/>' + dots
  }).join('')
  lsvg.innerHTML = lgrid + ticks + (kinds.length ? lines : '<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">No rate-limit readings logged in this period yet.</text>')
  document.getElementById('limit-legend').innerHTML = kinds.map((k, n) => {
    const pts = series(k)
    return '<span><i style="background:' + COLOR[Math.min(n, COLOR.length - 1)] + '"></i>' + esc(LIMIT_NAME[k] || k) + (pts.length ? ' ' + pts.at(-1)[1] + '%' : '') + '</span>'
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
// The project list is redrawn with the data, so its clicks are taken on the list.
document.getElementById('nav').onclick = e => {
  const b = e.target.closest('button')
  if (!b) return
  try { localStorage.setItem('usage-project', b.dataset.project) } catch {}
  set('project', b.dataset.project)
}
for (const b of document.querySelectorAll('[data-period]')) b.onclick = () => set('period', Number(b.dataset.period), 'usage-period')
for (const b of document.querySelectorAll('[data-step]')) b.onclick = () => set('step', Number(b.dataset.step), 'usage-step')
for (const b of document.querySelectorAll('[data-metric]')) b.onclick = () => set('metric', b.dataset.metric, 'usage-metric')
for (const c of document.querySelectorAll('[data-group]')) c.onchange = () => set('groups', Object.assign({}, state.groups, { [c.dataset.group]: c.checked }), 'usage-groups')
const render = () => { drawSide(); drawLimits(); draw() }
render()

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
