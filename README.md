# usage-statusline

English | [한국어](README.ko.md)

A Claude Code mod that puts usage in the status line under the prompt: each rate-limit window (usage, time until reset as `h:mm` or `Nd h:mm`, the window), then cost and tokens, each as this session / today:

```
4% 3:14(5h) · 10% 4d 8:13(7d) · $5.72 / $18.40 · 1.23M tok / 5.20M tok
```

It updates after every model response, mid-turn included, and each minute redraws the countdown and re-reads today's total. Rate limits are the account's, so the latest reading any session took is shared: a new or idle session shows them too, and they move within a minute as other sessions work (subscription accounts only; nothing shows until some session has had a response). Cost and tokens always show, at `$0.00` and `0 tok` in a session that has used nothing yet. It uses no tokens itself: it reads figures the engine already measured and draws them on screen only.

**Tokens** are summed from each model response's usage (the main thread's and subagents'), all four counts together: input, output, cache read and cache write. Cache reads re-count the conversation on every request, so the total grows much faster than the context window. It counts from when the mod loaded in this session; a resumed session starts again at zero. **Cost** is the engine's API-price estimate for this session; on a subscription it is not what you are billed.

**Today's totals** (cost and tokens) sum the sessions on this machine that ran with this mod since local midnight, each kept under its own key in the mod's store. Sessions on other machines or on the web, and those from before the mod was installed, are not counted. A session's whole cost counts on the day it was last measured.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install usage-statusline --marketplace leekd123/claude-usage-statusline
```

Answer `y` to add the marketplace, then pick a scope (user is first). From a shell instead:

```bash
claude plugin install usage-statusline --marketplace leekd123/claude-usage-statusline
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `leekd123/claude-usage-statusline`, then Add plugin.

Sessions already running pick it up with `/reload-plugins`; new sessions load it by themselves.

## Develop

Install from a local clone instead, so edits reach a session with `/reload-plugins` alone, no reinstall:

```bash
claude plugin marketplace add <path to your clone>
```

```bash
claude plugin install usage-statusline@usage-statusline --scope user
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
