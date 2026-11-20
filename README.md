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

Run `/usage-stats` to build the page from the usage log and open it in your browser. It is two files side by side, with no server or network: `stats.html`, the page itself, and `data.js`, the figures it draws.

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
- **Auto refresh**: the button at the foot of the sidebar turns it off and on, the list beside it sets how often (5s, 10s, 15s, 30s, 1m, 5m or 15m; 1m unless chosen), and the time to the next reload shows next to them.

The browser remembers every choice. The sidebar's foot also links to this repository on GitHub.

**When it updates**

- The mod rebuilds `data.js` when a session starts (`/reload-plugins` too), at the end of every turn, and each minute if a response was logged since. A long turn shows up while it runs.
- It writes `stats.html` only when a session starts (or when the file is missing). After a change to the page, `/reload-plugins` in one session puts the new page in place, and sessions still on older code leave it there, writing only `data.js`. Only a change to what `data.js` holds needs every session reloaded; until then the page says so instead of drawing.
- The page loads `data.js` again by itself (each minute unless you choose otherwise) and redraws in place, so keeping it open or bookmarking it is enough. It reloads whole only when `data.js` names a newer `stats.html`.
- `data.js` holds the log summed per day, project, session and model, and the page's own script draws from that. Changing a choice needs no rebuild.
- The sidebar's foot shows how long the last build took and how many lines it read. Every build reads the whole log, so if that time grows past a second or so, the build is due to keep per-day sums instead.

## Desktop widget (Windows)

A small translucent window on the desktop with the same figures, kept apart from Claude: `bin/usage-widget.exe`, a Rust program of about 200 KB that makes no network requests of its own. It shows what the mod last wrote, so while Claude is closed it keeps those figures and counts down to each reset, and it moves again once a session has a response.

**Starting and stopping**

- A session starts it when the session starts, unless you closed it. A second start brings the running one forward instead of opening another.
- `/usage-widget` opens it again after you closed it.
- **Start with Windows**, in its menu, starts it when you sign in to Windows, whether or not you closed it before.
- **Exit**, in its menu, closes it until `/usage-widget` or the next Windows sign-in. **Close when Claude closes** closes it about three minutes after the last session ends; the next session starts it again.
- It keeps running when Claude closes: Explorer starts it, not Claude.

**Using it**

- Drag it anywhere. Double-click it to open the statistics page; right-click it for the menu.
- **Items**: 5h and 7d usage, the time to each reset, and today's cost, tokens and agent time. A turn's agent time is added when the turn ends.
- **Usage bars**: a bar under each usage item, across its label and figure, so the whole item is 100%. Green, amber from 70% and red from 90%. On unless you turn it off under Appearance.
- **Appearance**: horizontal or vertical, usage bars and their thickness (Thin, Medium, Thick or Extra thick), font, System, Dark or Light theme or your own text and background colors, and 70, 85 or 100% opacity.
- **Always on top**: on unless you turn it off.
- Its size changes only when the items, font or layout do, never as the figures change: each cell is as wide as its widest value. Against the right or bottom edge of a screen, it stays against that edge.

**Files**

- Settings: `%APPDATA%\usage-widget\settings.json`. An edit there shows within a second.
- The mod writes `widget.json` next to the usage log on every redraw, so its time doubles as a heartbeat. `widget.closed` says whether you closed the widget.
- The widget runs as a copy next to the log, `usage-widget-<version>.exe`, so a plugin update can replace `bin/usage-widget.exe` while it runs. A newer copy closes an older one that is running and takes its place, and removes older copies when it starts.

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

The widget, after a change to `widget/`: build it and put the result in `bin/`, which is what the mod ships. Raise its version in `widget/Cargo.toml` and `WIDGET_VERSION` in `hooks/register.ts` together, so sessions copy and start the new one.

```bash
cargo test --manifest-path widget/Cargo.toml
```

```bash
cargo build --release --manifest-path widget/Cargo.toml && cp widget/target/release/usage-widget.exe bin/
```
