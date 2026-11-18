// The statistics page: one self-contained HTML file built from the daily JSONL logs.
// No server and no network: inline CSS and inline SVG.

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
}

type Sum = { responses: number; sessions: Set<string>; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }

const empty = (): Sum => ({ responses: 0, sessions: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })
const total = (s: Sum) => s.input + s.output + s.cacheRead + s.cacheWrite
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

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
      }]
    } catch {
      return []
    }
  })

const add = (s: Sum, e: Entry) => {
  s.responses++
  s.sessions.add(e.session)
  s.input += e.input
  s.output += e.output
  s.cacheRead += e.cacheRead
  s.cacheWrite += e.cacheWrite
  s.cost += e.cost
}

const group = (entries: Entry[], key: (e: Entry) => string) => {
  const map = new Map<string, Sum>()
  for (const e of entries) {
    if (!map.has(key(e))) map.set(key(e), empty())
    add(map.get(key(e))!, e)
  }
  return map
}

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const usd = (n: number) => `$${n.toFixed(2)}`
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

// The local days from `days - 1` days before `today` to `today`, oldest first.
const lastDays = (today: string, days: number) =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - (days - 1 - i))
    return d.toISOString().slice(0, 10)
  })

const card = (label: string, s: Sum) =>
  `<div class="card"><div class="label">${label}</div><div class="value">${fmt(total(s))} tok</div><div class="sub">${usd(s.cost)} · ${s.responses} responses · ${s.sessions.size} sessions</div></div>`

// Daily tokens over the last 30 days as bars. Each day's whole column takes the hover, so a day with a
// 1px bar is as easy to point at as a tall one; the tooltip is drawn by the page's script from data-tip.
const chart = (byDay: Map<string, Sum>, today: string) => {
  const days = lastDays(today, 30)
  const max = Math.max(1, ...days.map(d => total(byDay.get(d) ?? empty())))
  const w = 24, gap = 4, h = 160
  const bars = days
    .map((d, i) => {
      const s = byDay.get(d) ?? empty()
      const bh = Math.round((total(s) / max) * h)
      const x = i * (w + gap)
      const tip = `${d} · ${fmt(total(s))} tok · ${usd(s.cost)} · ${s.responses} responses`
      return `<g class="day" data-tip="${tip}" aria-label="${tip}"><rect class="hit" x="${x - gap / 2}" y="0" width="${w + gap}" height="${h}"/><rect x="${x}" y="${h - bh}" width="${w}" height="${Math.max(bh, 1)}" rx="3" class="${bh ? 'bar' : 'none'}"/>${i % 5 === 4 || i === 29 ? `<text x="${x + w / 2}" y="${h + 16}" text-anchor="middle">${d.slice(5)}</text>` : ''}</g>`
    })
    .join('')
  return `<div class="chart"><svg viewBox="0 0 ${30 * (w + gap)} ${h + 22}" role="img" aria-label="Tokens per day, last 30 days">${bars}</svg><div class="tip" hidden></div></div>`
}

const row = (name: string, s: Sum) =>
  `<tr><td>${esc(name)}</td><td>${s.responses}</td><td>${s.sessions.size}</td><td>${fmt(s.input)}</td><td>${fmt(s.output)}</td><td>${fmt(s.cacheRead)}</td><td>${fmt(s.cacheWrite)}</td><td><b>${fmt(total(s))}</b></td><td>${usd(s.cost)}</td></tr>`

const table = (first: string, rows: [string, Sum][]) =>
  `<table><thead><tr><th>${first}</th><th>Responses</th><th>Sessions</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Total</th><th>Cost</th></tr></thead><tbody>${rows.map(([n, s]) => row(n, s)).join('')}</tbody></table>`

const LIMIT_NAME: Record<string, string> = { five_hour: '5-hour window', seven_day: '7-day window', spend_limit: 'Spend limit' }

// One card per rate-limit window, as the last reading any session took. The page's script turns
// data-resets into a countdown, and shows 0% once the reset has passed, as the status line does.
const limitCard = (r: SessionRateLimit) =>
  `<div class="card limit" data-pct="${num(r.percentUsed)}"${r.resetsAt ? ` data-resets="${esc(r.resetsAt)}"` : ''}><div class="label">${esc(LIMIT_NAME[r.kind] ?? r.kind)}</div><div class="value pct">${num(r.percentUsed)}%</div><div class="meter"><i style="width:${Math.min(100, num(r.percentUsed))}%"></i></div><div class="sub reset">${r.resetsAt ? '' : 'no reset time reported'}</div></div>`

const limits = (rateLimits: readonly SessionRateLimit[]) =>
  rateLimits.length > 0
    ? `<div class="cards">${rateLimits.map(limitCard).join('')}</div>`
    : '<div class="note">No rate-limit reading yet. Subscription accounts get one with a session\'s first response.</div>'

// Cards, chart and tables for one project's entries ('' is every project's). Each project's view is drawn
// here and the sidebar only shows one, so the page needs no script to add anything up.
const view = (key: string, entries: Entry[], today: string) => {
  const byDay = group(entries, e => e.day)
  const within = (days: number) => {
    const from = lastDays(today, days)[0] ?? today
    const s = empty()
    for (const e of entries) if (e.day >= from && e.day <= today) add(s, e)
    return s
  }
  const all = empty()
  for (const e of entries) add(all, e)
  const byModel = [...group(entries, e => e.model)].sort((a, b) => total(b[1]) - total(a[1]))
  const days = [...byDay].sort((a, b) => b[0].localeCompare(a[0]))
  return `<section class="view" data-project="${esc(key)}"${key ? ' hidden' : ''}>
<h2>${key ? esc(key) : 'All projects'}</h2>
<div class="cards">${card('Today', within(1))}${card('Last 7 days', within(7))}${card('Last 30 days', within(30))}${card('All time', all)}</div>
<h2>Tokens per day, last 30 days</h2>
${chart(byDay, today)}
<h2>By model</h2>
<div class="scroll">${table('Model', byModel)}</div>
<h2>By day</h2>
<div class="scroll">${table('Day', days)}</div>
</section>`
}

export const statsHtml = (entries: Entry[], today: string, rateLimits: readonly SessionRateLimit[] = []) => {
  // Projects by their last day of use, the most recent first.
  const last = (list: Entry[]) => list.reduce((d, e) => (e.day > d ? e.day : d), '')
  const projects = [...group(entries, e => e.project)]
    .map(([name]) => [name, entries.filter(e => e.project === name)] as const)
    .sort((a, b) => last(b[1]).localeCompare(last(a[1])) || a[0].localeCompare(b[0]))
  const nav = [['', 'All projects', entries] as const, ...projects.map(([n, list]) => [n, n, list] as const)]
    .map(([key, name, list]) => `<button data-project="${esc(key)}"><span>${esc(name)}</span><small>${fmt(list.reduce((n, e) => n + e.input + e.output + e.cacheRead + e.cacheWrite, 0))}</small></button>`)
    .join('')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude usage</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--dim:#78716c;--line:#e7e5e4;--card:#fff;--bar:#d97757;--hover:#f5f5f4}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#1c1917;--fg:#f5f5f4;--dim:#a8a29e;--line:#44403c;--card:#292524;--bar:#e08a6d;--hover:#292524}}
:root[data-theme=dark]{--bg:#1c1917;--fg:#f5f5f4;--dim:#a8a29e;--line:#44403c;--card:#292524;--bar:#e08a6d;--hover:#292524}
:root{color-scheme:light}:root[data-theme=dark]{color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
.theme{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.theme button{font:inherit;font-size:12px;padding:4px 10px;border:0;background:var(--card);color:var(--dim);cursor:pointer}
.theme button+button{border-left:1px solid var(--line)}
.theme button[aria-pressed=true]{background:var(--fg);color:var(--bg)}
.chart{position:relative;padding-top:28px}.hit{fill:transparent}.day:hover .hit{fill:var(--hover)}
.tip{position:absolute;pointer-events:none;background:var(--fg);color:var(--bg);font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-100%)}
main{max-width:1100px;width:100%;box-sizing:border-box;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 8px}
.note{color:var(--dim);font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.label,.sub{color:var(--dim);font-size:12px}.value{font-size:20px;font-weight:600}
svg{width:100%;height:auto;display:block}svg text{fill:var(--dim);font-size:10px}
.bar{fill:var(--bar)}.none{fill:var(--line)}
.meter{height:6px;border-radius:3px;background:var(--line);margin:6px 0 4px;overflow:hidden}.meter i{display:block;height:100%;background:var(--bar)}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}th{color:var(--dim);font-weight:500}
.app{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;box-sizing:border-box;overflow-y:auto;display:flex;flex-direction:column;padding:20px 12px;border-right:1px solid var(--line);background:var(--card)}
.side h1{font-size:16px;margin:0 8px 20px}
.side .label{margin:0 0 6px 8px}
.side nav{display:flex;flex-direction:column;gap:2px}
.side nav button{display:flex;justify-content:space-between;gap:8px;font:inherit;text-align:left;padding:6px 8px;border:0;border-radius:6px;background:none;color:var(--fg);cursor:pointer}
.side nav button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.side small{color:var(--dim)}
.side nav button:hover{background:var(--hover)}.side nav button[aria-pressed=true]{background:var(--bg);box-shadow:inset 0 0 0 1px var(--line);font-weight:600}
.side .foot{margin-top:auto;padding:16px 8px 0;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
main>h2:first-child{margin-top:0}
@media (max-width:720px){.app{grid-template-columns:minmax(0,1fr)}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}.side nav{flex-direction:row;flex-wrap:wrap}.side .foot{margin-top:12px}}
</style></head><body><div class="app">
<aside class="side"><h1>Claude usage</h1><div class="label">Projects</div><nav aria-label="Projects">${nav}</nav>
<div class="foot"><div class="note">Built ${esc(today)} from this machine's usage-statusline logs</div>
<div class="theme" role="group" aria-label="Theme"><button data-theme="light">Light</button><button data-theme="dark">Dark</button><button data-theme="system">System</button></div></div></aside>
<main>
<h2>Rate limits</h2>
${limits(rateLimits)}
${view('', entries, today)}${projects.map(([n, list]) => view(n, list, today)).join('')}
<p class="note">Cost is the engine's API-price estimate, not what a subscription bills.</p>
</main></div>
<script>
// Theme: light, dark or the system's; the choice is kept in this browser (a file:// page may refuse storage).
const root = document.documentElement
const setTheme = t => {
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t)
  for (const b of document.querySelectorAll('.theme button')) b.setAttribute('aria-pressed', String(b.dataset.theme === t))
  try { localStorage.setItem('usage-theme', t) } catch {}
}
let saved = 'system'
try { saved = localStorage.getItem('usage-theme') || 'system' } catch {}
setTheme(saved)
for (const b of document.querySelectorAll('.theme button')) b.onclick = () => setTheme(b.dataset.theme)

// Rate limits: time left to each reset, redrawn each minute while the page stays open.
const pad = n => String(n).padStart(2, '0')
const drawLimits = () => {
  for (const card of document.querySelectorAll('.limit[data-resets]')) {
    const at = new Date(card.dataset.resets), min = Math.round((at - Date.now()) / 60000)
    const passed = min <= 0, pct = passed ? 0 : Number(card.dataset.pct)
    card.querySelector('.pct').textContent = pct + '%'
    card.querySelector('.meter i').style.width = Math.min(100, pct) + '%'
    const d = Math.floor(min / 1440), left = (d > 0 ? d + 'd ' : '') + Math.floor((min % 1440) / 60) + ':' + pad(min % 60)
    const when = at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    card.querySelector('.reset').textContent = passed ? 'Reset at ' + when + '; the next window starts with the next use' : 'Resets in ' + left + ' · ' + when
  }
}
drawLimits()
setInterval(drawLimits, 60000)

// Project filter: shows that project's view; the choice is kept like the theme, and falls back to
// every project when the kept one has no logs any more.
const setProject = p => {
  if (!document.querySelector('.view[data-project="' + CSS.escape(p) + '"]')) p = ''
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.project !== p
  for (const b of document.querySelectorAll('.side nav button')) b.setAttribute('aria-pressed', String(b.dataset.project === p))
  try { localStorage.setItem('usage-project', p) } catch {}
}
let project = ''
try { project = localStorage.getItem('usage-project') || '' } catch {}
setProject(project)
for (const b of document.querySelectorAll('.side nav button')) b.onclick = () => setProject(b.dataset.project)

// Chart tooltips: above the hovered day's column.
for (const chart of document.querySelectorAll('.chart')) {
  const tip = chart.querySelector('.tip')
  for (const g of chart.querySelectorAll('.day')) {
    g.onmouseenter = () => {
      const c = chart.getBoundingClientRect(), r = g.querySelector('.hit').getBoundingClientRect()
      tip.textContent = g.dataset.tip
      tip.hidden = false
      const half = tip.offsetWidth / 2
      tip.style.left = Math.min(Math.max(r.left - c.left + r.width / 2, half), c.width - half) + 'px'
      tip.style.top = r.top - c.top - 4 + 'px'
    }
    g.onmouseleave = () => { tip.hidden = true }
  }
}
</script></body></html>
`
}
