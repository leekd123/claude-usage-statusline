import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage } from 'claude-code'
import { NO_PROJECT, parseLog, statsData, statsPage, statsScript } from './stats'
import type { Entry, SessionInfo } from './stats'

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// The session's tokens so far, summed from each response's usage; $.state outlives a reload.
const tokens = atom({ plugin: 'usage-statusline', key: 'tokens' } as const, 0)

export type Line = {
  rateLimits: readonly SessionRateLimit[]
  cost: number
  costToday: number
  tokens: number
  tokensToday: number
}

export const left = (resetsAt: string, now: number) => {
  const min = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000))
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60
  const hm = `${h}:${String(m).padStart(2, '0')}`
  return d > 0 ? `${d}d ${hm}` : hm
}

// The local calendar day, YYYY-MM-DD.
export const day = (now: number) => new Date(now - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)

export const count = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)

// A window whose reset has passed since the last reading is empty now. Its next reset is not known
// until a response reports it (the 5h window starts again at the next use), so it shows no countdown.
export const limit = (r: SessionRateLimit, now: number) => {
  const name = LABEL[r.kind] ?? r.kind
  if (!r.resetsAt) return `${r.percentUsed}%(${name})`
  return Date.parse(r.resetsAt) <= now ? `0%(${name})` : `${r.percentUsed}% ${left(r.resetsAt, now)}(${name})`
}

// Cost and tokens always show, as this session / today, at 0 in a session that has used nothing yet.
export const format = ({ rateLimits, cost, costToday, tokens, tokensToday }: Line, now: number) =>
  [
    ...rateLimits.map(r => limit(r, now)),
    `$${cost.toFixed(2)} / $${costToday.toFixed(2)}`,
    `${count(tokens)} tok / ${count(tokensToday)} tok`,
  ].join(' · ')

// Each session writes only its own key per kind ('cost', 'tok'), so sessions running at once never
// overwrite each other. Each response adds what its log line carries, on the day it is logged, so today
// matches the page: a session's own counters restart on a resume and so cannot be stored as they stand.
// Sessions without this plugin, or on other machines, are not counted.
let adding: Promise<unknown> = Promise.resolve()
const add = ($: EngineInterface, kind: string, value: number, now: number) =>
  (adding = adding.then(async () => {
    if (value <= 0) return
    const key = `${kind}:${day(now)}:${await $.session.id()}`
    await $.store.set(key, Number((await $.store.get(key)) ?? 0) + value)
  }).catch(() => {})) // one response's subagents finish at once; adds run one at a time

// Re-read on the timer too: another session's use reaches this line within a minute, not at this session's next response.
const sumToday = async ($: EngineInterface, kind: string, now: number) => {
  const prefix = `${kind}:${day(now)}:`
  let total = 0
  for (const key of await $.store.keys()) {
    if (key.startsWith(prefix)) total += Number((await $.store.get(key)) ?? 0)
    else if (key.startsWith(`${kind}:`)) await $.store.delete(key) // an earlier day's
  }
  return total
}

// Rate limits are the account's, not the session's: the last fresh reading any session took is shared,
// so a new or idle session shows them too, and current.
const sharedLimits = async ($: EngineInterface) => (await $.store.get('limits')) as SessionRateLimit[] | undefined

// A reload runs session.start again and refetches, so a module variable is enough here.
let cost = 0
// The session cost already written to the log; each line carries what was added since.
let costLogged = 0
// Writes run one at a time: each reads the file and writes it back whole ($.fs has no append).
let writing: Promise<unknown> = Promise.resolve()
// A line was logged since stats.html was last built, so the minute timer has something to rebuild.
let dirty = false

// $.fs.read refuses a file over 4 MiB, so a file this big is left as it is and the lines go on in the next part.
export const ROLL_BYTES = 3 * 1024 * 1024

// One file per day and session, so sessions running at once never overwrite each other's lines.
// Part 1 has no number; later parts are <day>.<session>.2.jsonl and on.
const claudeDir = async ($: EngineInterface) =>
  (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))}/.claude`

const logDir = async ($: EngineInterface) => `${await claudeDir($)}/usage-statusline`

// The session root's folder name, as ponytail names a project.
const project = async ($: EngineInterface) => base(await $.session.root()) ?? ''

// A session's title and project as Claude Code knows them, from its transcript: the last custom-title
// record, and the cwd its lines carry. A search tool reads the transcript, so one of any size is never read
// whole: grep, as ponytail does, or on Windows, where Git's grep is seldom on the PATH, findstr, handed the
// text in a file since its quotes do not survive a command line. Other lines can quote that text (a
// conversation about it), so only a line that parses as the record counts.
export const TITLE_RECORD = '"type":"custom-title"'
export const CWD_RECORD = '"cwd":"'
const realPath = async ($: EngineInterface, path: string) => (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath

// The transcript's lines that hold `text`, in order.
const search = async ($: EngineInterface, file: string, text: string, name: string) => {
  let argv = ['grep', '-F', text, file]
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const pattern = `${await logDir($)}/${name}-pattern.txt`
    if (!(await $.fs.exists(pattern))) await $.fs.write(pattern, text) // no newline: an empty pattern matches every line
    argv = ['findstr', '/L', `/G:${await realPath($, pattern)}`, file]
  }
  const found = await $.process.run(argv).catch(() => undefined)
  return (found?.stdout ?? '').split(/\r?\n/)
}

// The first (or last) line that parses and gives `pick` a value; a line that only quotes the text gives none.
const first = (lines: string[], pick: (record: Record<string, unknown>) => unknown) => {
  for (const line of lines) {
    try {
      const value = pick(JSON.parse(line))
      if (typeof value === 'string' && value !== '') return value
    } catch {}
  }
  return undefined
}
const lastTitle = (lines: string[]) => first(lines.reverse(), r => (r.type === 'custom-title' ? r.customTitle : undefined))
const base = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1)

// This session's title, at a turn's end.
// shortcut: looks only in the projects folder named after the session root; a session moved by /cd or a
// worktree, or a root past 200 characters (hashed), gets no title here (the page may still look it up).
const title = async ($: EngineInterface) => {
  const folder = (await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')
  const file = await realPath($, `${await claudeDir($)}/projects/${folder}/${await $.session.id()}.jsonl`)
  return file ? lastTitle(await search($, file, TITLE_RECORD, 'title')) : undefined
}

// For a session the logs name no title or project for (one begun before they were logged): its transcript,
// under any projects folder, looked up once and kept in the store, found or not, so a build reads no
// transcript twice.
const sessionInfo = async ($: EngineInterface, entries: Entry[]) => {
  const titled = new Set(entries.filter(e => e.title).map(e => e.session))
  const placed = new Set(entries.filter(e => e.project !== NO_PROJECT).map(e => e.session))
  const info: Record<string, SessionInfo> = {}
  for (const session of new Set(entries.map(e => e.session))) {
    if (titled.has(session) && placed.has(session)) continue
    let known = (await $.store.get(`session:${session}`)) as SessionInfo | undefined
    if (!known) {
      known = {}
      const dir = `${await claudeDir($)}/projects`
      for (const folder of (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'dir')) {
        const file = await realPath($, `${dir}/${folder.name}/${session}.jsonl`)
        if (!file) continue
        const cwd = first(await search($, file, CWD_RECORD, 'cwd'), r => r.cwd)
        known = { title: lastTitle(await search($, file, TITLE_RECORD, 'title')), project: cwd && base(cwd) }
        break
      }
      await $.store.set(`session:${session}`, known)
    }
    info[session] = known
  }
  return info
}

const logFile = async ($: EngineInterface, now: number, part: number) =>
  `${await logDir($)}/${day(now)}.${await $.session.id()}${part > 1 ? `.${part}` : ''}.jsonl`

// Builds data.js from every day's logs, next to them, for stats.html to load on each of its reloads.
// Built at session start (a /reload-plugins too), at each main turn's end, and on the minute timer
// when a line was logged since; the page shows how long a build took and over how many lines.
// stats.html itself, the page's code, is written only at session start (or when it is missing), so a
// session still on older code never puts its older page back: the last session started has the newest.
// shortcut: reads every log on each build, up to once a minute per busy session; when the page's
// "Built in N ms" grows past a second or so, keep per-day sums and read only today's logs.
const writeStats = async ($: EngineInterface, page = false) => {
  await writing // this turn's lines first
  dirty = false
  const started = await $.clock.now()
  const dir = await logDir($)
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
  const texts = await Promise.all(files.map(f => $.fs.read(`${dir}/${f.name}`).catch(() => '')))
  const entries = files.flatMap((f, i) => parseLog(f.name.slice(0, 10), texts[i] ?? ''))
  const now = await $.clock.now()
  const info = await sessionInfo($, entries)
  const file = `${dir}/stats.html`
  // The page first, then the data naming it, so an open page that sees a new page named reloads whole.
  // Only a page that differs is written: the desktop app starts sessions of its own (pre-started ones, an
  // idle one resumed), and the same page written again would reload every open one for nothing.
  if (page || !(await $.fs.exists(file))) {
    const html = statsPage()
    if ((await $.fs.read(file).catch(() => undefined)) !== html) {
      await $.fs.write(file, html)
      await $.store.set('page', now)
    }
  }
  const pageAt = Number((await $.store.get('page')) ?? 0)
  const data = statsData(entries, day(now), (await sharedLimits($)) ?? [], { ms: now - started, lines: entries.length, files: files.length }, info, pageAt)
  await $.fs.write(`${dir}/data.js`, statsScript(data))
  return file
}

// Builds the page fresh and opens it in the browser.
const openStats = async ($: EngineInterface) => {
  const file = await writeStats($)
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const mac = !windows && (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  await $.process.run(windows ? ['cmd', '/c', 'start', '', file.replaceAll('/', '\\')] : [mac ? 'open' : 'xdg-open', file])
  return file
}

const log = ($: EngineInterface, entry: Record<string, unknown>, now: number) =>
  (writing = writing.then(async () => {
    for (let part = 1; ; part++) {
      const path = await logFile($, now, part)
      const stat = await $.fs.stat(path).catch(() => undefined)
      // A file that is there but cannot be stat'ed or read throws here, so it is never written over.
      if (!stat && (await $.fs.exists(path))) throw new Error(`cannot stat ${path}`)
      if ((stat?.size ?? 0) > ROLL_BYTES) continue
      const text = stat ? await $.fs.read(path) : '' // missing: the part's first line
      await $.fs.write(path, `${text}${JSON.stringify(entry)}\n`)
      dirty = true
      return
    }
  }).catch(() => {})) // a failed write loses one line, never the status line or the file

const show = async ($: EngineInterface, now: number) => {
  const used = await read($, tokens)
  await adding
  $.ui.status(
    format(
      {
        rateLimits: (await sharedLimits($)) ?? [],
        cost,
        costToday: (await sumToday($, 'cost', now)) + Math.max(0, cost - costLogged), // measured, not yet on a line
        tokens: used,
        tokensToday: await sumToday($, 'tok', now),
      },
      now,
    ),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({ name: 'usage-stats', description: 'Open usage statistics from the daily logs in the browser' })
    const now = await $.clock.now()
    const usage = await $.session.usage()
    cost = usage.cost?.usd ?? 0
    costLogged = cost // a resumed session's earlier cost was logged when it was spent
    // An earlier reading of this session's seeds the shared one only where none is kept yet.
    if (usage.rateLimits.length > 0 && !(await sharedLimits($))) await $.store.set('limits', usage.rateLimits)
    await show($, now)
    // The page's code and its data, so a /reload-plugins puts this code's page in place at once and other
    // sessions' builds leave it there; not awaited, it reads every log.
    void writeStats($, true).catch(() => {})
    // Each minute: the countdown, what other sessions have added to today and to the limits, and the
    // page when this session logged a line since its last build, so a long turn shows up mid-turn.
    $.clock.every(60_000, async () => {
      await show($, await $.clock.now())
      if (dirty) await writeStats($).catch(() => {})
    })
    return ran
  })

  // Every model response, mid-turn too, the main thread's and each subagent's: add its tokens and
  // redraw, so the line moves while the turn runs rather than only at its end.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u) {
      const used = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, tokens, n => n + used)
      cost = (await $.session.usage()).cost?.usd ?? cost
      const now = await $.clock.now()
      const added = Math.max(0, cost - costLogged)
      await add($, 'tok', used, now)
      await add($, 'cost', added, now)
      // shortcut: cost is the session's change since the last line, so a response's cost can land on the next line;
      // the day's sum is right. Per-response cost would need the price table.
      await log($, {
        t: new Date(now).toISOString(),
        session: await $.session.id(),
        project: await project($),
        agent: e.agentId,
        model: e.model,
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
        cost: added,
      }, now)
      costLogged = Math.max(costLogged, cost)
      await show($, now)
    }
    return result
  })

  // After each main turn the page is rebuilt, so an open stats.html shows the new figures on a refresh.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      // One line per main turn, however it ended, so the page can count turns beside responses; it carries
      // the turn's length and the session's title as of now, for the page's sessions table.
      const now = await $.clock.now()
      const session = await $.session.id()
      await log($, { t: new Date(now).toISOString(), session, project: await project($), turn: true, ms: e.durationMs, title: await title($) }, now)
      await writeStats($).catch(() => {})
    }
    return ran
  })

  on('command.run', { command: 'usage-stats' }, async $ => {
    const file = await openStats($).catch(() => undefined)
    return { text: file ? `Usage statistics opened: ${file}` : 'usage-statusline: could not build or open the statistics page' }
  })

  // A measurement carries the fresh rate-limit reading: share it with every session.
  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    cost = e.cost?.usd ?? cost
    if (e.rateLimits.length > 0) await $.store.set('limits', e.rateLimits)
    await show($, now)
    return next(e)
  })
}
