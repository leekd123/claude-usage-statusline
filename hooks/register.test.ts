import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code/testing'

import { count, day, format, left, limit, ROLL_BYTES } from './register'

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
// The log files written, without the stats.html each session start builds.
const logs = (files: Record<string, string>) => Object.keys(files).filter(p => p.endsWith('.jsonl'))

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
    `cost:${TODAY}:other`,
    `cost:${TODAY}:this`,
    'limits',
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

  // A main turn's end rebuilds the page without opening it; a subagent's does nothing.
  const done = { answer: '', durationMs: 65_000, isAborted: false, turnId: 't', reason: 'answer' as const }
  delete files[`${dir}stats.html`] // the one session start built
  await $.turn.complete({ ...done, agentId: 'a1' })
  expect(files[`${dir}stats.html`]).toBeUndefined()
  await $.turn.complete(done)
  expect(files[`${dir}stats.html`]).toContain('<td>big</td>')
  expect(ran.map(a => a[0])).toEqual(['grep']) // the title only: nothing opened
  expect(ran[0]!.at(-1)).toBe(transcript) // the path the engine resolved

  const { text } = await $.command.run({ command: 'usage-stats' })

  const page = files[`${dir}stats.html`]
  // The module's own spelling; the engine makes the path absolute where it touches the disk.
  expect(text).toBe('Usage statistics opened: /home/u/.claude/usage-statusline/stats.html')
  expect(ran.at(-1)).toEqual(['xdg-open', '/home/u/.claude/usage-statusline/stats.html'])
  expect(page).toContain('<div class="label">Today</div><div class="value">50.0k tok</div><div class="sub">$0.00 · 1 turns · 1 responses · 1 sessions</div>') // the main turn's end, not the subagent's
  expect(page).toContain('<div class="label">All time</div><div class="value">50.0k tok</div><div class="sub">$1.50 · 1 turns · 2 responses · 2 sessions</div>')
  expect(page).toContain('<td>2026-11-01</td><td>0</td><td>0s</td><td>1</td><td>1</td><td>1</td><td>2</td><td>3</td><td>4</td><td><b>10</b></td><td>$1.50</td>')
  expect(page).toContain('<td>big</td>')
  // A row per session, the most recently used first: its title from the turn line, else the start of its id.
  expect(page).toContain('<h2>Sessions</h2>')
  expect(page).toContain('<tr><td>Usage stats</td><td>alpha</td><td><time datetime="2026-11-13T12:00:00.000Z">2026-11-13 12:00</time></td>')
  expect(page).toContain('<td>1</td><td>1</td><td>1m 5s</td><td><b>50.0k</b></td><td>$0.00</td></tr><tr><td class="id">other</td><td>(no project)</td>')
  // One table per grouping, Day alone shown until the checkboxes say otherwise; by day and model, a row per pair.
  expect(page).toContain('<div class="scroll breakdown" data-by="day,model" hidden><table class="two"><thead><tr><th>Day</th><th>Model</th><th>Responses</th>')
  expect(page).toContain('<tr><td>2026-11-01</td><td>big</td><td>1</td><td>1</td><td>1</td><td>2</td><td>3</td><td>4</td><td><b>10</b></td><td>$1.50</td></tr>')
  expect(page).toContain('<div class="scroll breakdown" data-by="day"><table><thead><tr><th>Day</th><th>Turns</th>')
  expect(page).toContain('<div class="scroll breakdown" data-by="model" hidden>')
  expect(page).toContain('<tr><td>All time</td><td>1</td><td>1m 5s</td><td>2</td><td>2</td>') // no grouping: one row, turns and their time included
  expect(page).toContain('<th>Model</th><th>Responses</th>') // turns have no model: no Turns column there
  expect(page).not.toContain('<td>?</td>') // and no row for the turn lines
  expect(page).toContain('No rate-limit reading yet') // none shared in this store
  expect(page).toContain('<a class="repo" href="https://github.com/leekd123/claude-usage-statusline"')

  // A sidebar entry and a view per project, the most recently used first; a line from before the
  // project was logged counts under "(no project)". Each view holds only its own project's lines.
  expect(page).toContain(
    '<button data-project=""><span>All projects</span><small>50.0k</small></button><button data-project="alpha"><span>alpha</span><small>50.0k</small></button><button data-project="(no project)"><span>(no project)</span><small>10</small></button>',
  )
  const alpha = page!.split('<section class="view" data-project="alpha" hidden>')[1]!.split('</section>')[0]!
  expect(alpha).toContain('<div class="label">All time</div><div class="value">50.0k tok</div><div class="sub">$0.00 · 1 turns · 1 responses · 1 sessions</div>')
  expect(alpha).not.toContain('<td>big</td>')

  // The shared reading shows as one card per window, its reset time for the page's countdown.
  store.limits = LIMITS
  await $.command.run({ command: 'usage-stats' })
  expect(files[`${dir}stats.html`]).toContain(
    '<div class="card limit" data-pct="4" data-resets="2026-11-13T15:23:00Z"><div class="label">5-hour window</div><div class="value pct">4%</div>',
  )
  expect(files[`${dir}stats.html`]).toContain('<div class="label">7-day window</div>')
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
  const page = () => Object.keys(files).find(p => p.endsWith('stats.html'))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(0) // the unawaited build settles
  const built = page()!
  expect(files[built]).toContain('<button aria-pressed="true">Auto refresh</button>')
  expect(files[built]).toContain(' in 0 ms, 0 lines in 0 files') // the mock clock stands still while it builds

  delete files[built]
  await clock.advance(60_000)
  expect(page()).toBeUndefined() // nothing logged since: no rebuild

  await drain($.turn.step({ ...step, index: 0 }))
  await clock.advance(60_000)
  expect(files[built]).toContain(' in 0 ms, 1 lines in 1 files') // the new line, mid-turn
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
