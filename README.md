# usage-statusline

English | [한국어](README.ko.md)

A Claude Code mod that puts usage in the status line under the prompt: each rate-limit window (usage, time until reset as `h:mm` or `Nd h:mm`, the window), then cost and tokens, each as this session / today:

```
4% 3:14(5h) · 10% 4d 8:13(7d) · $5.72 / $18.40 · 1.23M tok / 5.20M tok
```

It updates after every model response, mid-turn included, and each minute redraws the countdown and re-reads today's total. Rate limits are the account's, so the latest reading any session took is shared: a new or idle session shows them too, and they move within a minute as other sessions work (subscription accounts only; nothing shows until some session has had a response). Cost and tokens always show, at `$0.00` and `0 tok` in a session that has used nothing yet. It uses no tokens itself: it reads figures the engine already measured and draws them on screen only.

**Tokens** are summed from each model response's usage (the main thread's and subagents'), all four counts together: input, output, cache read and cache write. Cache reads re-count the conversation on every request, so the total grows much faster than the context window. It counts from when the mod loaded in this session; a resumed session starts again at zero. **Cost** is the engine's API-price estimate for this session; on a subscription it is not what you are billed.

**Today's totals** (cost and tokens) sum the sessions on this machine that ran with this mod since local midnight, each kept under its own key in the mod's store. Sessions on other machines or on the web, and those from before the mod was installed, are not counted. A session's whole cost counts on the day it was last measured.

**Usage log.** Every model response that reports usage also adds one JSON line to `~/.claude/usage-statusline/<YYYY-MM-DD>.<session id>.jsonl` (under `CLAUDE_CONFIG_DIR` when that is set), one file per local day and session, for your own statistics:

```
{"t":"2026-11-17T01:03:12.000Z","session":"…","project":"…","agent":"…","model":"…","input":1000,"output":2000,"cacheRead":40000,"cacheWrite":7000,"cost":0.12}
```

`project` is the name of the session's root folder. `agent` is there only for a subagent's response. Each main turn's end adds a line with `"turn":true` and no tokens, so the page can count turns: one turn (a message and the answer to it) holds many responses, one per model request. `cost` is the session's estimated cost added since the previous line, so one response's cost can land on the next line; a day's sum is right. A file past 3 MiB is left as it is and the lines go on in `<YYYY-MM-DD>.<session id>.2.jsonl`, then `.3`, and so on. The mod only writes these files and never deletes them.

**Statistics page.** Run `/usage-stats` to build `stats.html` next to the logs from every day's files and open it in your browser: each rate-limit window (the latest reading any session took, how much is used, and the time left to its reset, counting down while the page is open), totals for today, the last 7 and 30 days and all time, a bar chart of tokens per day over the last 30 days (point at a day for its figures), and a breakdown table: the Day and Model checkboxes above it group the rows by day, by model, by day and model, or (both unchecked) into one all-time row, and the browser keeps the choice. The sidebar on the left filters these by project (lines logged before projects were recorded show under `(no project)`), and the browser keeps the choice. Light, Dark and System at the bottom of the sidebar pick the theme, and the browser keeps the choice; a link there opens this repository on GitHub. It is a plain file with no server or network. The mod rebuilds it when a session starts (and on `/reload-plugins`), at the end of every turn, and each minute when a response was logged since, so a long turn shows up while it runs; the page reloads itself each minute, so keeping it open (or bookmarking it) is enough. The sidebar's foot says how long the last build took and how many lines it read: every build reads every log, so if that time grows past a second or so, the build is due to keep per-day sums instead.

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
