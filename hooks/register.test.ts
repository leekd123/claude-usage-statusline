import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code/testing'

import { count, day, format, left, limit } from './register'

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
const engine = (on: On, store: Record<string, unknown>, lines: (string | undefined)[]) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'this' }))
  on('ui.status', (_, e) => (lines.push(e.text), { value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
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
  engine(on, store, lines)
  // Stands in for the API: requests 0 and 1 report usage, request 2 got no response.
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

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(lines.at(-1)).toBe('$0.00 / $10.00 · 0 tok / 900.0k tok') // no limits read anywhere yet

  const step = { turnId: 't', model: 'm', messageCount: 1 }
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
})
