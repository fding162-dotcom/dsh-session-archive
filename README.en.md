# dsh-session-archive

[中文说明](README.md) · English

> A **session archive** plugin for [DeepSeek Harness](https://github.com/deepseek-ai).
> **Treat old sessions of the same workspace as storage — a new session can pull out "what happened" from the previous ones, stretching your context from one session into a chain.**

MIT licensed. Read-only: it never writes to your session files.

## The problem

DSH sessions are isolated. Open a new one and it has no idea where it was or what it was doing — which is exactly what long sessions need, because **sessions degrade when they run too long**: the longer the context, the more likely the thinking collapses into one-character output like `Do.` `OK.` `Run.`.

This plugin gives any session six read-only actions:

- see which sessions exist in this workspace, when each started, how big it is
- extract "what the user last said, what was last done, how far it degraded" in one call
- read details, search keywords with surrounding context
- get an overview plus degradation warnings
- see what a parallel session is doing right now

## Install

### Windows (recommended: one command)

```powershell
.\install.ps1
```

It backs up your profile, adds the plugin to `bundles` + `dependencies`, creates a junction in `node_modules`, and tells you how to roll back. Then **fully quit DSH and start it again** — the tool `session_archive` will appear.

- another profile: `.\install.ps1 -Profile web`
- uninstall: `.\install.ps1 -Uninstall` (removes the link and the registration; **your session files are never touched**)

> Editing a profile's JSON by hand is the easiest way to break your DSH install — that's why the script exists.

### Manual (macOS / Linux)

```bash
git clone https://github.com/fding162-dotcom/dsh-session-archive.git ~/plugins/dsh-session-archive
cp ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/desktop/package.json.bak
# edit profile/package.json:
#   add "dsh-session-archive" to dsh.profile.bundles
#   add "dsh-session-archive": "link:/absolute/path/to/plugins/dsh-session-archive" to dependencies
ln -s /absolute/path/to/plugins/dsh-session-archive ~/.dsh/profiles/desktop/node_modules/dsh-session-archive
```

Restart DSH.

> **Requires Node.js 22.15+ on your system.** DSH ships as an Electron app and its own runtime cannot execute scripts directly, so the plugin looks for `nodePath` in config, then `node` in PATH, then common install locations. If none is found it falls back to a single-frame decoder and says so clearly in the result.
> **Workspace** defaults to the current process cwd. If the target workspace directory is not found under `~/.dsh/sessions`, the plugin falls back to listing **all** workspaces and says so — better than giving you no clue.

## The six actions

Tool name: `session_archive`

| action | does | when |
|---|---|---|
| `list` | all sessions in this workspace: id / start time / last activity / size / event count; ★ marks the newest | you don't know the previous session's id |
| `timeline` | **time line**: the most recent N sessions, each with the user's last line, the last reply and the last tool call | "what was I just doing?" at a glance |
| `digest` | summary: start, turns, degradation check, last things the user said, last actions taken | first thing when taking over |
| `read` | last N messages in time order | you need details |
| `search` | keyword search across sessions; `context: N` adds N lines before/after | "did I ever mention this?" |
| `stats` | overview: session count / events / size, recent days, largest sessions, degradation warnings | how long has this workspace lived, which sessions are slipping |
| `live` | sessions active in the last N minutes (default 10) and what they're doing | what the parallel session is up to |

### Parameters

| param | used by | meaning |
|---|---|---|
| `sessionId` | digest / read | when omitted **the newest is skipped** (usually the current session) and the previous one is returned; with or without the `session-` prefix |
| `self` | digest / read | `true` = look at the newest one (yourself) |
| `count` | digest / read / live | digest: 12 messages + 10 actions; read: 40; live: 5 sessions |
| `query` | search | keyword |
| `maxSessions` | search | how many sessions to scan at most (default 5) |
| `context` | search | context lines around each hit (0–5) |
| `minutes` | live | activity window in minutes (default 10) |

### Never pick the wrong session

The response always states which session the archive belongs to, and when you pass a `sessionId` that doesn't exist it errors out instead of silently switching to a different session.

## Output cap

A single response is hard-capped at **12,000 characters**: `list` shows at most 50 sessions, `stats` the last 14 days, `search` at most 30 hits — anything beyond is truncated and the remainder is reported. Long output can never blow up your context.

## Known limitations (good starting points for contributors)

1. **The startup snapshot is computed once, at DSH boot.** The 5 entries in the system prompt are generated when the plugin loads; opening another window in the same process still shows that boot-time snapshot. Making it live would require hooking DSH's session-creation event, which I haven't confirmed exists.
2. **Requires Node.js 22.15+ on the system.** DSH ships as Electron and its runtime cannot execute scripts; without node the plugin falls back to a single-frame decoder (incomplete data, with an explicit warning).
3. **A single compressed session above 60 MB is not read**, to avoid blowing up memory.
4. **If the workspace directory can't be found, it falls back to listing all workspaces** — so a wrong path still gives you a clue instead of nothing.
5. **`-` in paths collides with the path separator** in DSH's own escaping (`D:-b\c` and `D:\c` map to the same name). That's DSH's rule; the plugin just follows it.
6. **Reading a session that is being written** may return an incomplete snapshot (during DSH's rewrite); it now says so.
7. **The one-command installer is Windows-only**; macOS/Linux need manual profile editing.

## Troubleshooting

| symptom | check |
|---|---|
| no `session_archive` tool after restart | ① right profile name (`ls ~/.dsh/profiles`) ② fully restart DSH, not just refresh the page ③ `index.js` present in the plugin dir |
| DSH won't start | copy `package.json.bak-<timestamp>` back over `package.json` |
| `list` says no sessions found | the workspace has no sessions yet, or `workspace` points elsewhere |
| first `list` is a bit slow | expected: it decompresses session heads once, then caches them in `~/.dsh/session-archive-cache.json` |
| a session can't be read | a single compressed session above 60 MB is refused on purpose to avoid blowing memory; it reports an error instead of hanging |

## Safety

Read-only. The plugin only ever reads files under `~/.dsh/sessions`; it never writes to them. Deleting the plugin loses no history.

## License

MIT.
