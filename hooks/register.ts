import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage } from 'claude-code'

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
// overwrite each other.
// shortcut: a session's whole total counts on the day it was last updated (one crossing midnight,
// or a resumed one, lands on the later day); sessions without this plugin, or on other machines, are not counted.
const record = async ($: EngineInterface, kind: string, value: number, now: number) =>
  $.store.set(`${kind}:${day(now)}:${await $.session.id()}`, value)

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

const show = async ($: EngineInterface, now: number) => {
  const used = await read($, tokens)
  if (cost > 0) await record($, 'cost', cost, now)
  if (used > 0) await record($, 'tok', used, now)
  $.ui.status(
    format(
      {
        rateLimits: (await sharedLimits($)) ?? [],
        cost,
        costToday: await sumToday($, 'cost', now),
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
    const now = await $.clock.now()
    const usage = await $.session.usage()
    cost = usage.cost?.usd ?? 0
    // An earlier reading of this session's seeds the shared one only where none is kept yet.
    if (usage.rateLimits.length > 0 && !(await sharedLimits($))) await $.store.set('limits', usage.rateLimits)
    await show($, now)
    // Each minute: the countdown, and what other sessions have added to today and to the limits.
    $.clock.every(60_000, async () => show($, await $.clock.now()))
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
      await show($, await $.clock.now())
    }
    return result
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
