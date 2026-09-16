# Agents panel: Claude and GPT in the Parlay sidebar

Design note, Sep 15 2026. No code yet. "Verified" means run or read on Dave's machine today
(Claude Code 2.1.272, Codex CLI 0.154.0-alpha.6.2, fork of VS Code 1.135). Everything else is marked.

The brief: a real terminal, pinned next to Aqua / Meshy / Sonar, running Claude Code or Codex,
with a switch that carries the conversation from one to the other.

## 1. Where the panel lives

**Recommendation: (a) move VS Code's own Terminal view into the right sidebar by default.**
One line of core code, a real PTY, zero new terminal code, and the tabs are the agents.

| Option | What it is | Verdict |
|---|---|---|
| (a) Terminal container defaults to the auxiliary bar | `src/vs/workbench/contrib/terminal/browser/terminal.contribution.ts:115` registers the container with `ViewContainerLocation.Panel`; change it to `ViewContainerLocation.AuxiliaryBar` (enum at `src/vs/workbench/common/views.ts:39`). The Terminal becomes a fourth icon beside Aqua / Meshy / Sonar. | **Do this.** The terminal already supports living in a side location: `terminalGroup.ts:293/483/570` and `terminalInstance.ts:2685/2934` switch split orientation on `location !== Panel` because users can drag it there today. Parlay's pin CSS (`src/vs/workbench/browser/media/style.css:536`) hides the close button for the whole aux bar, so it is locked in place like Meshy. Users who already dragged views keep their layout (`views.customizations`, `viewDescriptorService.ts:41`). |
| (b) Terminal in the editor area | `createTerminal({ location: TerminalLocation.Editor })` (stable API, `vscode.d.ts:7751`) or the setting `terminal.integrated.defaultLocation: "editor"` (`terminalConfiguration.ts:121`). | Good width for a TUI, but it is a tab among code tabs, not pinned. Keep as the built-in "pop out" (VS Code already has *Move Terminal into Editor Area*). |
| (c) xterm.js in a webview view | Render a terminal ourselves inside `parlay.agents`. | **No.** A webview has no PTY; the extension would need its own `node-pty` built for the fork's Electron ABI, then re-implement tabs, persistence, keybindings, theming, shell integration. A second, worse terminal. |
| (d) Core "Parlay Agents" ViewPane hosting a TerminalInstance | A new pane beside Aqua that embeds one live terminal. | **No.** The only core precedent is `testing/browser/testResultsView/testResultsOutput.ts:461` and it uses `createDetachedTerminal` (xterm with no process). A live instance is glued to `ITerminalGroupService` inside the 694-line `TerminalViewPane`; you would fork that and diverge from upstream for the same look (a) gives. |

Files that change for (a): `terminal.contribution.ts` (1 line; possibly `order:` so it sorts after Aqua / Meshy / Sonar, unverified how core and extension containers interleave). `extensions/parlay/src/extension.ts:67` runs `positionPanelBottom` once; harmless, the bottom panel keeps Problems / Output.
Effort: about an hour including the 10-minute build.
Trade-off to accept: a TUI wants ~80+ columns. At Parlay's 13px mono that is a ~600px sidebar. Dave drags it wider once; VS Code remembers.

## 2. Switching Claude <-> GPT with the conversation carried over

Two agent tabs in that Terminal view, both alive; "Continue in GPT" renders a handoff file and starts (or reuses) the other tab. No model call to produce the handoff.

### 2a. Read the active CLI's session

**Claude Code** (verified): `~/.claude/projects/<slug>/<sessionId>.jsonl`, slug = cwd with every `:` `\` `.` turned into `-` (`C--Users-Dave-MAQUOKETA-Documents-GitHub-drydock`; a lowercase `c--` variant exists when launched from Git Bash, so list the dir case-insensitively). Records to keep: `type: "user" | "assistant"` with `message.content` either a string or an array of `{type: text | thinking | tool_use | tool_result}`. Keep `text` only. Skip `attachment`, `system`, `mode`, `file-history-*`, `queue-operation`, `last-prompt`, `ai-title`, `atis-latch`, `cost-state`, `continued-in`. Each record also carries `cwd`, `gitBranch`, `permissionMode`, `sessionId`.
Knowing the id: launch with `--session-id <uuid>` we generate (verified flag), so the file path is known before the first turn. Fallbacks: `~/.claude/sessions/<pid>.json` lists live sessions as `{pid, sessionId, cwd, kind, status, name}` (verified), and `~/.claude/history.jsonl` has `{project, sessionId}` per prompt (verified).

**Codex** (verified): `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. Line 1 is `type: "session_meta"` with `payload.{session_id, cwd, originator, source, cli_version}`. Turns are `type: "response_item"`, `payload.type: "message"`, `payload.role: user | assistant | developer`, `payload.content[] = {type: input_text | output_text, text}`. Skip `developer` (injected instructions), `reasoning`, `custom_tool_call*`, `event_msg`, `turn_context`, `token_usage_record`. `turn_context.payload` has `model`, `approval_policy`, `sandbox_policy`, `effort`.
Knowing the id: no launch flag exists (verified: `codex --help` has none). Pick the newest rollout whose `session_meta.cwd` equals the workspace; that is what `codex resume --last` picks too (cwd-filtered, `--all` disables). `~/.codex/session_index.jsonl` maps `{id, thread_name, updated_at}`; `~/.codex/thread-writer-locks/<id>.lock` marks live threads (unverified whether removed on exit).
Warning: `session_meta.history_mode: "paginated"` and a `codex migrate-rollouts` subcommand (verified) mean Codex is moving history into sqlite (`~/.codex/thread_history_1.sqlite`). Rollout JSONL is still written today; treat the parser as breakable and keep the fallback in 2d.

### 2b. Render the handoff

`<workspace>/.parlay/handoff.md`: a header (from which model, session id, cwd, branch, permission/sandbox mode, time) then the last N text turns as `**User:** / **Assistant:**` blocks. Defaults: N = 20, each turn cut to ~2,000 chars, whole file capped near 30 KB (~8k tokens), the final assistant message kept whole. Text only: tool calls and tool results are what make a 47-turn Claude session 12 MB (verified), and they are also where secrets and file contents live.
Add `.parlay/` to `.git/info/exclude` (one write, no repo change) so it never lands in a commit. Alternative: `ctx.storageUri` outside the repo; then both CLIs read a path outside cwd, which Codex's read-only sandbox allows and Claude may prompt for (unverified).

### 2c. Start the other CLI

Both TUIs take an initial prompt as a positional argument (verified from `--help`; the TUI submitting it on start is what the help says, not exercised today). Pass the file path, not the text, so the Windows 32,767-char command-line limit and shell quoting never matter.

Claude -> GPT:
```
codex "Read .parlay/handoff.md: it is my conversation so far with another assistant. Continue from its last message, which is mine."
```
GPT -> Claude:
```
claude --session-id <new-uuid> -n "<workspace> (from GPT)" "Read .parlay/handoff.md: it is my conversation so far with another assistant. Continue from its last message, which is mine."
```
Alternative for Claude: `--append-system-prompt-file .parlay/handoff.md` (verified: the flag parses and reads the file; a missing file gives `Error: Append system prompt file not found`). It puts the handoff in context with no Read tool call, but the system prompt is snapshotted for the whole conversation (`--system-prompt-snapshot`, verified in help), so stale handoff text rides along on every request. Prefer the plain prompt.
Resuming your own side needs no handoff: `claude --resume <id>` / `codex resume <id>` (both verified).

Paths: `claude.exe` lives at `~/.local/bin/claude.exe` and is on PATH in Git Bash (verified). `codex.exe` is at `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` and is on **no** PATH here, Git Bash or PowerShell (verified); Dave runs it through the Codex Desktop app. Add a `parlay.codexCommand` setting whose default globs that folder, mirroring `parlay.claudeCommand`. Launching from Git Bash converts `/x/y` arguments into `C:\...\Git\x\y` (verified with a bogus path), so always pass relative or Windows paths.

### 2d. Two tabs vs one that swaps

**Two tabs (recommended).** "Continue in GPT" leaves Claude running in its tab, writes the handoff, and starts Codex in a second tab (or types the prompt into an existing idle Codex tab). Switching back later costs nothing: the other side is still there, or one `resume`. The terminal tab list is the model switcher.
**One swapping tab** means exiting the running CLI first (`/exit` for Claude; Codex's quit command unverified), waiting for `onDidEndTerminalShellExecution` (stable, needs shell integration in the host shell), then launching the other. Fragile on ConPTY; skip.

Fallback when parsing fails: let the departing model write the handoff itself. `claude -p --resume <id> "Write a handoff summary..." > .parlay/handoff.md` or `codex exec resume <id> "Write a handoff summary..." -o .parlay/handoff.md` (flags verified, not exercised). Costs one turn.

## 3. Ergonomics for 24/7 use

- **Model switcher = the terminal tabs**, plus two title-bar buttons on the Terminal view: *Continue in GPT* / *Continue in Claude*, contributed to `view/title` with `when: view == terminal && parlay.agent == claude|codex` (that menu is how the terminal's own toolbar is built, `terminalMenus.ts:420-516`). The context key follows `window.onDidChangeActiveTerminal` (stable).
- **Which model is active**: the tab name and icon (`Claude`, `GPT`) plus one status bar item `$(sparkle) Claude` next to the existing Script Sync light (`extension.ts:86`). Clicking it opens a quick pick: Continue in the other / New Claude / New GPT / Resume last.
- **Native "+" menu**: contribute two terminal profiles (`contributes.terminal.profiles` + `registerTerminalProfileProvider`, stable, `vscode.d.ts:8220/11825`) so the Terminal view's own "+" dropdown lists Claude and GPT beside PowerShell. Run them through the shell (as `send()` does today) rather than as `shellPath`, so the tab survives the CLI exiting.
- **Keybindings** (borrowed from the official Claude Code extension, installed here as 2.1.66): `ctrl+escape` focus the active agent tab, `ctrl+shift+escape` continue in the other, `alt+k` insert `file:line` of the selection into the agent's prompt (`terminal.sendText(text, false)`).
- **Per-workspace memory**: `ctx.workspaceState` holds `{lastAgent, claudeSessionId, codexSessionId}`. On reopen, the status item offers *Resume Claude* / *Resume GPT*. Name Claude sessions after the folder with `-n` (verified) so `/resume` pickers read well.
- **Borrow / avoid**: the official Claude Code extension already has a `claudeCode.useTerminal` mode and an *Open in Terminal* command, which is this design; avoid its webview chat (the reason for this panel) and its `preferredLocation` sprawl. The Codex VS Code extension is not installed here; the Desktop app drives sessions over an app-server (`codex --remote ws://`, `codex agents`, verified in help). `codex queue --thread <id> --message <text>` injects a message into a running Codex session from outside the pty (verified in help, not exercised): a later "send selection to GPT" that does not fight the TUI for keystrokes. Claude has the same via `claude --bg` / `attach`.

## 4. Risks

- **Cost**: never re-feed a whole transcript. Text-only last 20 turns is ~5-10k tokens, one cheap turn. Both accounts are quota-based (Claude Max, ChatGPT login, verified), so long contexts burn the rolling window rather than dollars. The model-written summary fallback costs a turn of the departing model.
- **Privacy**: transcripts hold file contents, tool output and anything a secret leaked into. Text-only rendering drops most of it; the handoff still crosses vendors (Anthropic -> OpenAI and back). Keep it out of git (`.git/info/exclude`), keep the cap, and show the file before sending on first use.
- **Permission modes**: Claude `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan` (verified) and Dave has auto mode configured; Codex `-a on-request|never`, `-s read-only|workspace-write|danger-full-access`, `--approve-for-me`, and `[windows] sandbox = "unelevated"` in `~/.codex/config.toml` (verified). The two are not equivalent; the handoff header should state the mode the last session ran in, and Parlay should launch each CLI with an explicit mode setting rather than inheriting whatever the last manual run used.
- **Windows terminal**: both CLIs are native exes and run under ConPTY from PowerShell or Git Bash. Claude Code's Bash tool needs Git Bash (`CLAUDE_CODE_GIT_BASH_PATH` is set in Dave's environment, verified). Full-screen TUIs repaint badly on ConPTY resizes (Dave's settings have `tui: fullscreen` and `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1`, verified); Codex offers `--no-alt-screen` inline mode (verified) which also keeps scrollback in the VS Code terminal, a good default in a sidebar. `claude` resolves only where `~/.local/bin` is on PATH; `codex` resolves nowhere: both commands must be settings with full-path defaults.
- **Format drift**: Codex history is mid-migration to sqlite; Claude's JSONL has grown many record types. Parse defensively, fall back to the model-written summary.

## Effort

Core: 1 line + rebuild, ~1 hour. Extension: one new `agents.ts` (two profiles, two parsers, renderer, two commands, context key, status item, workspace state, `parlay.codexCommand`), roughly 150-200 lines, 1-2 days including trying both handoff directions live.

## Open questions for Dave

1. A ~600px right sidebar for the TUIs, or agents pop to the editor area when the window is wide?
2. Two live tabs (recommended) or one tab that swaps?
3. Handoff as the last 20 text turns (free) or a model-written summary (one turn, better)?
4. Handoff file in the workspace `.parlay/` (visible, git-excluded) or in VS Code's storage folder?
5. Put `codex.exe` on PATH, or let Parlay find it under `%LOCALAPPDATA%\OpenAI\Codex\bin`?
6. Which permission / sandbox mode should each CLI start in when Parlay launches it?
