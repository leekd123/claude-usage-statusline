import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code/testing'

import { count, day, format, left, limit, ROLL_BYTES, WIDGET_VERSION } from './register'
import { statsData, statsScript } from './stats'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const TODAY = day(NOW)
// turn.step streams: reading the stream through is what runs the hooks.
const drain = async (stream: AsyncIterable<unknown>) => {
  for await (const _ of stream);
}
const USAGE = { input_tokens: 1_000, output_tokens: 2_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 7_000 }
const LIMITS = [
  { kind: 'five_hour', percentUsed: 4, resetsAt: '2026-11-13T15:23:00Z' },
  { kind: 'seven_day', percentUsed: 10, resetsAt: '2026-11-17T20:00:00Z' },
]

// The engine beneath: a store, a clock, and a session that has used nothing.
// Stands in for the API: requests 0 and 1 report usage, request 2 got no response.
const api = (on: On) =>
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: e.index < 2 ? { ...USAGE, model: e.model } : null,
    }
  })
const step = { turnId: 't', model: 'm', messageCount: 1 }
// The log files written, without the page and data each session start builds.
const logs = (files: Record<string, string>) => Object.keys(files).filter(p => p.endsWith('.jsonl'))
// What data.js sets window.USAGE to.
const dataOf = (js: string | undefined) => JSON.parse(js!.slice('window.USAGE = '.length))
// What a session started later wrote to stats.html, for a session on older code to leave alone.
const NEWER = '<!-- a newer session -->'

// A file named in `broken` is there but cannot be stat'ed.
const engine = (
  on: On,
  store: Record<string, unknown>,
  lines: (string | undefined)[],
  files: Record<string, string> = {},
  broken = new Set<string>(),
  clock = true, // false: the test brings mock.clock, whose timers it can run
  windows = false, // true: the OS variable says Windows
) => {
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : e.name === 'OS' && windows ? 'Windows_NT' : undefined }))
  on('fs.stat', (_, e) => {
    if (files[e.path] === undefined || broken.has(e.path)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: files[e.path].length, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('fs.exists', (_, e) => ({ value: files[e.path] !== undefined }))
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_, e) => ((files[e.path] = e.text), { value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'this' }))
  on('session.root', () => ({ value: '/work/alpha' }))
  on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
  if (clock) {
    on('clock.now', () => ({ value: NOW }))
    on('clock.every', () => ({ value: undefined }))
  }
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => ((store[e.key] = e.value), { value: undefined }))
  on('store.delete', (_, e) => (delete store[e.key], { value: undefined }))
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
}

test('countdown, token count and line', () => {
  expect(left('2026-11-13T14:13:00Z', NOW)).toBe('2:13')
  expect(left('2026-11-16T16:00:00Z', NOW)).toBe('3d 4:00')
  expect(left('2026-11-13T11:00:00Z', NOW)).toBe('0:00')
  expect(TODAY).toMatch(/^2026-11-1[34]$/)
  expect([count(950), count(50_000), count(1_234_567)]).toEqual(['950', '50.0k', '1.23M'])
  expect(limit({ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-13T14:13:00Z' }, NOW)).toBe('40% 2:13(5h)')
  expect(limit({ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-13T11:59:00Z' }, NOW)).toBe('0%(5h)') // reset passed
  expect(limit({ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-13T12:00:00Z' }, NOW)).toBe('0%(5h)') // resets now
  expect(limit({ kind: 'spend_limit', percentUsed: 12 }, NOW)).toBe('12%(spend)')
  expect(format({ rateLimits: [], cost: 0, costToday: 0, tokens: 0, tokensToday: 0 }, NOW)).toBe('$0.00 / $0.00 · 0 tok / 0 tok')
})

test('a new session shows the shared limits and zeros for itself', async ($, on) => {
  const store: Record<string, unknown> = { limits: LIMITS, [`cost:${TODAY}:other`]: 3, [`tok:${TODAY}:other`]: 2_000 }
  const lines: (string | undefined)[] = []
  engine(on, store, lines)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(lines.at(-1)).toBe('4% 3:23(5h) · 10% 4d 8:00(7d) · $0.00 / $3.00 · 0 tok / 2.0k tok')
})

test('a session whose counter restarted adds to what it used earlier today, not over it', async ($, on) => {
  const store: Record<string, unknown> = { [`tok:${TODAY}:this`]: 700_000 }
  const lines: (string | undefined)[] = []
  engine(on, store, lines, {})
  api(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await drain($.turn.step({ ...step, index: 0 }))
  expect(lines.at(-1)).toBe('$0.00 / $0.00 · 50.0k tok / 750.0k tok')
  expect(store[`tok:${TODAY}:this`]).toBe(750_000)
})

test('responses add tokens mid-turn, a measure shares its limits, and today sums the sessions', async ($, on) => {
  const store: Record<string, unknown> = {
    [`cost:${TODAY}:other`]: 10,
    [`tok:${TODAY}:other`]: 900_000,
    'cost:2026-01-01:old': 99,
    'tok:2026-01-01:old': 5,
  }
  const lines: (string | undefined)[] = []
  const files: Record<string, string> = {}
  engine(on, store, lines, files)
  api(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(lines.at(-1)).toBe('$0.00 / $10.00 · 0 tok / 900.0k tok') // no limits read anywhere yet

  await drain($.turn.step({ ...step, index: 0 }))
  expect(lines.at(-1)).toBe('$0.00 / $10.00 · 50.0k tok / 950.0k tok') // mid-turn, before any measure
  await drain($.turn.step({ ...step, index: 1, agentId: 'a1' })) // a subagent's request counts too
  await drain($.turn.step({ ...step, index: 2 })) // no response: adds nothing
  await $.session.measure({ context: { window: 200_000 }, rateLimits: LIMITS, cost: { usd: 5.72 }, changed: ['rateLimits', 'cost'] })

  expect(lines.at(-1)).toBe('4% 3:23(5h) · 10% 4d 8:00(7d) · $5.72 / $15.72 · 100.0k tok / 1.00M tok')
  expect(store.limits).toEqual(LIMITS)
  expect(Object.keys(store).sort()).toEqual([
    `cost:${TODAY}:other`, // this session's cost goes in with its next line
    'limits',
    'page', // when session start wrote stats.html
    'time', // today's agent time, summed by each build
    `tok:${TODAY}:other`,
    `tok:${TODAY}:this`,
  ])

  // One line per response that reported usage, in this day's file for this session.
  const [[path, text]] = Object.entries(files).filter(([p]) => p.endsWith('.jsonl'))
  expect(path.replaceAll('\\', '/')).toEndWith(`/home/u/.claude/usage-statusline/${TODAY}.this.jsonl`) // the engine makes it absolute
  const log = text.trim().split('\n').map(l => JSON.parse(l))
  const tokens = { input: 1_000, output: 2_000, cacheRead: 40_000, cacheWrite: 7_000 }
  expect(log).toEqual([
    { t: '2026-11-13T12:00:00.000Z', session: 'this', project: 'alpha', model: 'm', ...tokens, cost: 0 },
    { t: '2026-11-13T12:00:00.000Z', session: 'this', project: 'alpha', agent: 'a1', model: 'm', ...tokens, cost: 0 },
  ])
})

test('/usage-stats builds the page from every day\'s logs and opens it', async ($, on) => {
  const files: Record<string, string> = {}
  const ran: string[][] = []
  const store: Record<string, unknown> = {}
  engine(on, store, [], files)
  api(on)
  on('fs.list', () => ({
    value: Object.keys(files).map(p => ({ name: p.split(/[\\/]/).at(-1)!, kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }))
  // grep finds the session's title in its transcript (the last of two); uname says Linux.
  const titles = '{"type":"custom-title","customTitle":"Old"}\n{"type":"custom-title","customTitle":"Usage stats"}\n'
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: e.argv[0] === 'grep' ? titles : 'Linux\n', stderr: '' } }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await drain($.turn.step({ ...step, index: 0 })) // today: 50k tokens, model m
  const [today] = logs(files)
  const dir = today.slice(0, today.length - `${TODAY}.this.jsonl`.length)
  // The session's transcript, where its title is looked for (what grep answers stands for its content).
  const transcript = dir.replace(/usage-statusline([\\/])$/, 'projects$1-work-alpha$1this.jsonl')
  files[transcript] = ''
  // An earlier day, another session and model, with a line cut off mid-write.
  files[`${dir}2026-11-01.other.jsonl`] =
    `${JSON.stringify({ session: 'other', model: 'big', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 1.5 })}\n{"cut`

  // A main turn's end rebuilds the data without opening the page; a subagent's does nothing. The page
  // itself, the same for every build, is left as the latest session start wrote it.
  const done = { answer: '', durationMs: 65_000, isAborted: false, turnId: 't', reason: 'answer' as const }
  delete files[`${dir}data.js`] // the one session start built
  files[`${dir}stats.html`] = NEWER
  await $.turn.complete({ ...done, agentId: 'a1' })
  expect(files[`${dir}data.js`]).toBeUndefined()
  await $.turn.complete(done)
  expect(files[`${dir}data.js`]).toContain('"m":"big"')
  expect(files[`${dir}stats.html`]).toBe(NEWER)
  expect(ran.map(a => a[0])).toEqual(['grep']) // the title only: nothing opened
  expect(ran[0]!.at(-1)).toBe(transcript) // the path the engine resolved

  await $.command.run({ command: 'usage-stats' })
  expect(files[`${dir}stats.html`]).toBe(NEWER) // opening rebuilds the data alone too
  delete files[`${dir}stats.html`]
  const { text } = await $.command.run({ command: 'usage-stats' })

  const page = files[`${dir}stats.html`] // a missing page is written
  // The module's own spelling; the engine makes the path absolute where it touches the disk.
  expect(text).toBe('Usage statistics opened: /home/u/.claude/usage-statusline/stats.html')
  expect(ran.at(-1)).toEqual(['xdg-open', '/home/u/.claude/usage-statusline/stats.html'])
  // The data carries the logs summed per day, project, session and model ('' for turn lines), and each
  // session's latest title; the page's script draws the period, chart and tables from them.
  const data = dataOf(files[`${dir}data.js`])
  expect(data.version).toBe(2)
  const T = '2026-11-13T12:00:00.000Z'
  const none = { r: 0, n: 0, ms: 0, i: 0, o: 0, cr: 0, cw: 0, c: 0 }
  expect(data.today).toBe(TODAY)
  expect(data.titles).toEqual({ this: 'Usage stats' }) // the latest grep found, from the turn line
  expect([...data.rows].sort((a, b) => (a.s + a.m).localeCompare(b.s + b.m))).toEqual([
    // An earlier day's line with no time and no project; the cut-off line is skipped.
    { d: '2026-11-01', h: 0, p: '(no project)', s: 'other', m: 'big', ...none, r: 1, i: 1, o: 2, cr: 3, cw: 4, c: 1.5, f: '', l: '' },
    { d: TODAY, h: new Date(T).getHours() + (new Date(T).getMinutes() >= 30 ? 0.5 : 0), p: 'alpha', s: 'this', m: '', ...none, n: 1, ms: 65_000, f: T, l: T }, // the main turn, not the subagent's
    { d: TODAY, h: new Date(T).getHours() + (new Date(T).getMinutes() >= 30 ? 0.5 : 0), p: 'alpha', s: 'this', m: 'm', ...none, r: 1, i: 1_000, o: 2_000, cr: 40_000, cw: 7_000, f: T, l: T },
  ])
  // What the script draws into, and its choices: period, metric, grouping.
  for (const id of ['nav', 'built', 'limits', 'scope', 'kpis', 'chart', 'breakdown', 'sessions']) expect(page).toContain(`id="${id}"`)
  expect(page).toContain('<script src="data.js"></script>')
  expect(page!.indexOf("getItem('usage-theme')")).toBeLessThan(page!.indexOf('<body>')) // the theme is set before anything is painted
  expect(page).toContain('<div class="seg" role="group" aria-label="period"><button data-period="1">Today</button><button data-period="3">3d</button><button data-period="7">7d</button><button data-period="14">14d</button><button data-period="30">30d</button><button data-period="90">90d</button><button data-period="0">All</button></div>')
  expect(page).toContain('<button data-metric="turns">Turns</button><button data-metric="responses">Responses</button>')
  expect(data.limits).toEqual([]) // none shared in this store
  expect(page).toContain('<a class="repo" href="https://github.com/leekd123/claude-usage-statusline"')

  // A sidebar entry per project, the most recently used first, with its tokens; a line from before the
  // project was logged counts under "(no project)".
  expect(data.projects).toEqual([['alpha', 50_000], ['(no project)', 10]])

  // The shared reading goes in whole, for the page to draw a card per window and count down to its reset.
  store.limits = LIMITS
  await $.command.run({ command: 'usage-stats' })
  expect(dataOf(files[`${dir}data.js`]).limits).toEqual(LIMITS)
})

test('a full log file rolls to the next part, and one that cannot be stat\'ed is never written over', async ($, on) => {
  const files: Record<string, string> = {}
  const broken = new Set<string>()
  engine(on, {}, [], files, broken)
  api(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const lineCount = (path: string) => files[path].trim().split('\n').length

  await drain($.turn.step({ ...step, index: 0 }))
  const [first] = logs(files)
  files[first] = 'x'.repeat(ROLL_BYTES + 1) // stands in for a day of lines
  await drain($.turn.step({ ...step, index: 0 }))
  await drain($.turn.step({ ...step, index: 0 }))

  const second = first.replace(/\.jsonl$/, '.2.jsonl')
  expect(logs(files)).toEqual([first, second])
  expect(files[first]).toBe('x'.repeat(ROLL_BYTES + 1)) // left as it was
  expect(lineCount(second)).toBe(2)

  broken.add(second)
  await drain($.turn.step({ ...step, index: 0 }))
  expect(lineCount(second)).toBe(2) // the line is lost, the file kept
})

test('the page is built at session start, and on the minute timer only after a new line', async ($, on) => {
  const files: Record<string, string> = {}
  engine(on, {}, [], files, undefined, false)
  api(on)
  const clock = mock.clock(on, { now: NOW })
  on('fs.list', () => ({
    value: Object.keys(files).map(p => ({ name: p.split(/[\\/]/).at(-1)!, kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }))
  const find = (name: string) => Object.keys(files).find(p => p.endsWith(name))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0) // the unawaited build settles
  const page = find('stats.html')!, built = find('data.js')!
  expect(files[page]).toContain('<button aria-pressed="true">Auto refresh</button>')
  expect(dataOf(files[built]).built).toEqual({ ms: 0, lines: 0, files: 0 }) // the mock clock stands still while it builds
  expect(dataOf(files[built]).page).toBe(NOW) // names the page session start wrote, for an open page to reload on

  delete files[built]
  await clock.advance(60_000)
  expect(find('data.js')).toBeUndefined() // nothing logged since: no rebuild

  files[page] = NEWER
  await drain($.turn.step({ ...step, index: 0 }))
  await clock.advance(60_000)
  expect(dataOf(files[built]).built).toEqual({ ms: 0, lines: 1, files: 1 }) // the new line, mid-turn
  expect(files[page]).toBe(NEWER) // the page is session start's to write
  expect(dataOf(files[built]).page).toBe(NOW) // still the same page: an open one only redraws

  // Another session start (one the desktop app starts, or an idle one resumed) puts this code's page
  // back, naming it anew, only where the page differs from it.
  await clock.advance(60_000)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)
  expect(files[page]).toContain('<button aria-pressed="true">Auto refresh</button>')
  const rewritten = dataOf(files[built]).page
  expect(rewritten).toBeGreaterThan(NOW)
  await clock.advance(60_000)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0)
  expect(dataOf(files[built]).page).toBe(rewritten) // the same page: not written, not named anew
})

test('on Windows the title is found with findstr, and a line that only quotes the record is passed over', async ($, on) => {
  const files: Record<string, string> = {}
  const ran: string[][] = []
  engine(on, {}, [], files, undefined, true, true) // on Windows
  api(on)
  // findstr's answer: the record, then a later line of conversation that quotes its text.
  const found = '{"type":"custom-title","customTitle":"Win title"}\r\n{"type":"user","text":"grep for \\"type\\":\\"custom-title\\""}\r\n'
  on('process.run', (_, e) => (ran.push([...e.argv]), { value: { exitCode: 0, stdout: found, stderr: '' } }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await drain($.turn.step({ ...step, index: 0 }))
  const [log] = logs(files)
  const dir = log!.slice(0, log!.length - `${TODAY}.this.jsonl`.length)
  const transcript = dir.replace(/usage-statusline([\\/])$/, 'projects$1-work-alpha$1this.jsonl')
  files[transcript] = ''

  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' })

  expect(files[`${dir}title-pattern.txt`]).toBe('"type":"custom-title"') // the text findstr looks for, no newline
  expect(ran.find(a => a[0] === 'findstr')).toEqual(['findstr', '/L', `/G:${dir}title-pattern.txt`, transcript])
  expect(files[log!]).toContain('"turn":true,"ms":1000,"title":"Win title"}')
})

test('a title or project with markup in it stays data: it cannot end the data script or add a tag', () => {
  const evil = '</script><img src=x onerror=alert(1)>'
  const js = statsScript(statsData(
    [{ day: '2026-11-13', session: 's', project: evil, model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turn: true, t: '2026-11-13T00:00:00.000Z', ms: 0, title: evil }],
    '2026-11-13',
  ))
  expect(js).not.toContain('<')
  expect(dataOf(js).titles.s).toBe(evil) // as JSON reads it back
})

test('a session begun before projects were logged counts under the project its later lines name', () => {
  const line = { day: '2026-11-18', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turn: false, ms: 0 }
  const data = statsData(
    [
      { ...line, session: 'a', project: '(no project)', t: '2026-11-18T00:00:00.000Z' }, // before the reload
      { ...line, session: 'a', project: 'calc', t: '2026-11-18T00:20:00.000Z' },
      { ...line, session: 'b', project: '(no project)', t: '2026-11-18T00:10:00.000Z' }, // never named one (the same half hour, so one row each)
    ],
    '2026-11-18',
  )
  expect(data.rows.map(r => [r.s, r.p, r.r])).toEqual([['a', 'calc', 2], ['b', '(no project)', 1]])
  // Same last day, so by name: "(no project)" first. Session a sits under calc alone.
  expect(data.projects).toEqual([['(no project)', 1], ['calc', 2]])
})

test('a session the logs name no title or project for gets both from its transcript, looked up once', async ($, on) => {
  const files: Record<string, string> = {}
  const store: Record<string, unknown> = {}
  const greps: string[][] = []
  engine(on, store, [], files)
  api(on)
  // The projects folder holds one folder; any other path lists the logs.
  on('fs.list', (_, e) => ({
    value: /projects$/.test(e.path)
      ? [{ name: 'D--work-old-app', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }]
      : Object.keys(files).map(p => ({ name: p.split(/[\\/]/).at(-1)!, kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }))
  // grep answers from the transcript: its title records (and a line quoting one), or the lines with a cwd.
  on('process.run', (_, e) => {
    greps.push([...e.argv])
    const stdout = e.argv[2] === '"type":"custom-title"'
      ? '{"type":"custom-title","customTitle":"Old work"}\n{"type":"user","text":"\\"type\\":\\"custom-title\\""}\n'
      : '{"type":"user","cwd":"D:\\\\work\\\\old-app"}\n{"type":"assistant","cwd":"D:\\\\work\\\\old-app"}\n'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await drain($.turn.step({ ...step, index: 0 }))
  const [log] = logs(files)
  const dir = log!.slice(0, log!.length - `${TODAY}.this.jsonl`.length)
  // A session from before titles and projects were logged, and its transcript.
  files[`${dir}2026-11-12.old.jsonl`] = `${JSON.stringify({ t: '2026-11-12T09:00:00.000Z', session: 'old', model: 'm', input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })}\n`
  files[dir.replace(/usage-statusline([\\/])$/, 'projects$1D--work-old-app$1old.jsonl')] = ''

  await $.command.run({ command: 'usage-stats' })
  const data = dataOf(files[`${dir}data.js`])
  expect(data.titles.old).toBe('Old work')
  expect(data.rows.find((r: { s: string }) => r.s === 'old').p).toBe('old-app')
  expect(store['session:old']).toEqual({ title: 'Old work', project: 'old-app' })
  expect(store['session:this']).toEqual({}) // its transcript is not there: kept as not found
  const searched = greps.length

  await $.command.run({ command: 'usage-stats' })
  expect(greps.slice(searched).every(a => a[0] !== 'grep')).toBe(true) // no transcript read again
})

test('the desktop app scratch folders show as one project', () => {
  const line = { day: '2026-11-18', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turn: false, ms: 0, t: '2026-11-18T00:00:00.000Z' }
  const data = statsData(
    [
      { ...line, session: 'a', project: 'scratch-2026-11-10-1cd218' },
      { ...line, session: 'b', project: 'scratch-2026-11-13-e2d38a' },
      { ...line, session: 'c', project: 'scratch-pad' }, // a folder of that name, not the app's
      { ...line, session: 'd', project: 'spare-6PkYnH' },
    ],
    '2026-11-18',
  )
  expect(data.rows.map(r => [r.s, r.p])).toEqual([['a', '(scratch)'], ['b', '(scratch)'], ['c', 'scratch-pad'], ['d', '(scratch)']])
  expect(data.projects).toContainEqual(['(scratch)', 3])
})

test('on Windows the widget reads today\'s figures from widget.json and starts unless the person closed it', async ($, on) => {
  // The widget the mod ships, wherever the plugin's folder is, and its copy once `copy` made it (the
  // engine hands the hooks absolute paths, the commands get them as the mod spelled them).
  let copied = false
  const exes = (k: string) => /[\\/]bin[\\/]usage-widget\.exe$/.test(k) || (copied && k.endsWith(`usage-widget-${WIDGET_VERSION}.exe`))
  const files = new Proxy<Record<string, string>>({}, { get: (t, k: string) => (exes(k) ? 'exe' : t[k]) })
  const ran: string[][] = []
  engine(on, {}, [], files, undefined, true, true) // on Windows
  api(on)
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    if (e.argv[2] === 'copy') copied = true // cmd /c copy /y <from> <to>
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('command.run', () => ({ text: '' }))
  on('turn.complete', () => ({ text: '' }))
  on('fs.list', () => ({
    value: Object.keys(files).map(p => ({ name: p.split(/[\\/]/).at(-1)!, kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const json = Object.keys(files).find(k => k.endsWith('widget.json'))!
  const dir = json.slice(0, -'widget.json'.length)
  // Commands get native paths: backslashes only.
  const exe = 'usage-statusline' + String.fromCharCode(92) + `usage-widget-${WIDGET_VERSION}.exe`
  expect(ran.map(a => a[0])).toEqual(['cmd', 'explorer.exe'])
  expect(ran[1]![1]!.endsWith(exe) && !ran[1]![1]!.includes('/')).toBe(true)

  await drain($.turn.step({ ...step, index: 0 }))
  await $.turn.complete({ answer: '', durationMs: 90_000, isAborted: false, turnId: 't', reason: 'answer' })
  const widget = JSON.parse(files[json]!)
  expect(widget).toMatchObject({ version: WIDGET_VERSION, at: NOW, tokensToday: 50_000, timeToday: 90_000 })
  expect(widget.stats.endsWith('usage-statusline' + String.fromCharCode(92) + 'stats.html')).toBe(true)

  // Closed by the person: a new session leaves it closed; /usage-widget opens it again.
  ran.length = 0
  files[`${dir}widget.closed`] = 'closed'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(ran).toEqual([])
  await $.command.run({ command: 'usage-widget', args: '' })
  expect(files[`${dir}widget.closed`]).toBe('')
  expect(ran.map(a => a[0])).toEqual(['explorer.exe']) // the copy is there already

  // A copy under this version's name that differs from the shipped file (bin/ rebuilt) is copied again.
  ran.length = 0
  copied = false
  files[`${dir}usage-widget-${WIDGET_VERSION}.exe`] = 'an older build'
  await $.command.run({ command: 'usage-widget', args: '' })
  expect(ran.map(a => a[0])).toEqual(['cmd', 'explorer.exe'])
})
