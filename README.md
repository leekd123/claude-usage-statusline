# usage-statusline

English | [한국어](README.ko.md)

A Claude Code mod that shows your usage in the status line under the prompt, keeps a log of it, and draws that log as a statistics page in your browser. It uses no tokens itself: it only reads figures the engine has already measured.

## Status line

```
4% 3:14(5h) · 10% 4d 8:13(7d) · $5.72 / $18.40 · 1.23M tok / 5.20M tok
```

- **Rate limits**: each window's usage, the time until it resets (`h:mm` or `Nd h:mm`), and the window. Subscription accounts only.
- **Cost** and **tokens**: this session / today.
- It updates after every model response, mid-turn included. Each minute it redraws the countdown and re-reads today's totals.
- Rate limits belong to the account, so the latest reading any session took is shared. A new or idle session shows them too, and they move within a minute as other sessions work. Nothing shows until some session has had a response.
- Cost and tokens always show, as `$0.00` and `0 tok` in a session that has used nothing yet.

**What the numbers count**

| | |
|---|---|
| Tokens | Every model response's usage, the main thread's and subagents': input, output, cache read and cache write together. Cache reads count the conversation again on every request, so the total grows much faster than the context window. Counted from when the mod loaded in this session; a resumed session starts again at zero. |
| Cost | The engine's API-price estimate for this session. On a subscription it is not what you are billed. |
| Today | The sessions on this machine that ran with this mod since local midnight. Sessions on other machines or on the web, and those from before the mod was installed, are not counted. Each response counts on the day it is logged, the same as on the statistics page. |

## Statistics page

Run `/usage-stats` to build `stats.html` from the usage log and open it in your browser. It is one file, with no server or network.

**What it shows**

- **Rate limits**: each window's usage and the time left to its reset, counting down while the page is open.
- **A card per metric** for the period: sessions, turns, responses, agent time, cost and tokens, each with its change from the period before.
- **A chart** of any one of those metrics per day. Point at a day for its figures.
- **Breakdown**: a table grouped by day, by model, by both, or (neither) into one row for the period. Turns and agent time show only where the rows are not grouped by model, since a turn has no model.
- **Sessions**: a row per session used in the period, most recently used first, with its title, project, first and last use in your local time, turns, responses, agent time, tokens and cost.

**What you can change**

- **Period**: Today, 7d, 30d, 90d or All, at the top.
- **Project**: the sidebar on the left filters everything by project. Lines logged before projects were recorded show under `(no project)`, and the desktop app's own folders for a conversation with no folder picked (`scratch-<day>-<id>`) and for the sessions it starts ahead of time (`~/.claude/spares/spare-<id>`) together under `(scratch)`.
- **Chart metric** and **breakdown grouping**: the buttons above the chart and the Day and Model checkboxes above the breakdown.
- **Theme**: Light, Dark or System, at the foot of the sidebar.
- **Auto refresh**: the button at the foot of the sidebar shows the seconds to the next reload and turns it off and on.

The browser remembers every choice. The sidebar's foot also links to this repository on GitHub.

**When it updates**

- The mod rebuilds the page when a session starts (`/reload-plugins` too), at the end of every turn, and each minute if a response was logged since. A long turn shows up while it runs.
- The page reloads itself each minute, so keeping it open or bookmarking it is enough.
- The mod puts the log into the page summed per day, project, session and model, and the page's own script draws from that. Changing a choice needs no rebuild.
- The sidebar's foot shows how long the last build took and how many lines it read. Every build reads the whole log, so if that time grows past a second or so, the build is due to keep per-day sums instead.

## Usage log

Every model response that reports usage adds one JSON line to a file per local day and session:

```
~/.claude/usage-statusline/<YYYY-MM-DD>.<session id>.jsonl
```

(under `CLAUDE_CONFIG_DIR` when that is set). A response's line:

```
{"t":"2026-11-17T01:03:12.000Z","session":"…","project":"…","agent":"…","model":"…","input":1000,"output":2000,"cacheRead":40000,"cacheWrite":7000,"cost":0.12}
```

| Field | Meaning |
|---|---|
| `project` | The name of the session's root folder. |
| `agent` | Only on a subagent's response. |
| `cost` | The session's estimated cost added since the previous line, so one response's cost can land on the next line. A day's sum is right. |

Each main turn's end adds a line with `"turn":true` and no tokens, so the page can count turns. One turn (a message and the answer to it) holds many responses, one per model request. That line also carries:

- `ms`: how long the turn took.
- `title`: the session's title as Claude Code shows it, the last `custom-title` record in its transcript. It is found with `grep` as ponytail does, or with `findstr` on Windows, where Git's `grep` is seldom on the PATH.

A session whose lines carry no title or project (one begun before they were logged) has them looked up once in its transcript, under any projects folder: its last `custom-title` record and the folder its lines' `cwd` names. The result is kept in the mod's store, so no transcript is read twice. A session with no transcript shows the start of its id and `(no project)`.

A file past 3 MiB is left as it is, and the lines go on in `<YYYY-MM-DD>.<session id>.2.jsonl`, then `.3`, and so on. The mod only writes these files and never deletes them.

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
