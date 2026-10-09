# Codex with a GitHub Copilot seat

This fork's experimental adapter runs **real Codex**, including Code Mode, its native tool loop, apply_patch, shell commands and session history. The official GitHub Copilot SDK handles the existing CLI login, account routing and model catalog. Its [request handler](https://github.com/github/copilot-sdk/blob/main/nodejs/src/copilotRequestHandler.ts) forwards GPT Responses requests unchanged. For Opus 5.5 it translates Codex's Responses protocol to Anthropic Messages. Only Codex runs the tools; the SDK does not run a second coding agent.

## Run on Linux

Requires Node.js 22+ (tested with 22.23.3), an authenticated `copilot` CLI (tested with 1.0.95), and the installed Codex executable bundle (tested with 0.162.1). Docker is needed only for the optional container launcher.

```bash
npm ci --prefix scripts/copilot-pilot --ignore-scripts
node scripts/copilot-pilot/host-run.mjs -C /path/to/project
# Arguments after -- go to Codex:
node scripts/copilot-pilot/host-run.mjs -C /path/to/project -- resume --last
```

The configured machine has `codex-copilot` and Bash aliases `cx` and `cxf`, all using the host launcher. Both launchers default to GPT-6.1 Sol (`gpt-6.1-sol`), max reasoning, and the full advertised context limit. The enabled Copilot catalog currently advertises 1,050,000 total context tokens, with a 922,000-token input limit and 128,000-token output limit. Auto-compaction retains headroom at 95% of the input limit (875,900 tokens). Limits are read from the provider catalog at launch. `--model`, `--reasoning`, `--state-dir`, `--copilot-bin`, and `--codex-bin` override these choices. The Codex binary must retain its companion executables, including `codex-code-mode-host`. Changes to Rust are unnecessary for this transport integration.

All launchers explicitly set `features.api_key_model_discovery=false`. Codex 0.161 enables API-key model discovery by default, but this bridge implements Responses rather than Codex's discovery endpoint. The Copilot SDK still checks the seat's enabled model catalog and context limits at every launch. This setting applies to `cxf`, `cxo`, the direct launcher, and Docker; verify it with `cxf features list`.

### Streaming and compaction

Active Responses requests have no adapter-imposed total-duration deadline. The bridge cancels after five minutes without upstream bytes; Codex's own SSE inactivity limit is six minutes so the bridge can report its error first. Opus thinking activity emits progress events while preserving signed thinking. A stalled, truncated or failed stream reports failure, cancels the outstanding request, and releases the SDK session. The adapter never fabricates completion or automatically replays a partially executed tool call.

The October 9 investigation found two GPT requests interrupted almost exactly 300 seconds after the preceding tool result, with about 265k and 388k input tokens. The original bridge timer and SDK `sendAndWait` each imposed a five-minute total limit. These limits predated the API-key discovery change; they have been replaced with inactivity and session-lifecycle handling. The Copilot provider uses HTTP streaming with WebSockets disabled. The separate `websocket closed by server before response.completed` message from regular Codex is outside this bridge.

Compaction uses Codex's native local summarization through the normal model endpoint. The provider explicitly sets `capabilities.remote_compaction="unsupported"`, since the bridge does not implement the new remote compaction protocol. `model_auto_compact_token_limit_scope="total"` counts the whole context. GPT's 875,900-token and Opus's 828,400-token thresholds retain output headroom; the full context windows and max reasoning defaults are unchanged. Compaction itself can take time and obeys the same inactivity watchdog.

Restart existing `cxf` and `cxo` processes after upgrading to load the updated adapter and binary. Existing sessions can then be resumed normally.

### Opus 5.5 option

```bash
source ~/.bash_aliases
cxo  # Claude Opus 5.5, max reasoning, full context, host YOLO mode
# Equivalent explicit launcher:
codex-copilot --model claude-opus-5.5 --reasoning max
```

`cxf` still defaults to GPT-6.1 Sol. Opus uses the seat's enabled `claude-opus-5.5` model with a 1,000,000-token window and up to 128,000 output tokens. Compaction starts at 828,400 tokens, retaining output space and 5% input headroom. A temporary Codex model catalog sets the actual context cap, so Codex's bundled or unknown-model limits cannot silently reduce the selected model's window. Known GPT metadata retains its bundled instructions and tools with the Copilot catalog's context limits.

The Opus translation supports text, images, function tools, namespaced tools, custom tools (including Code Mode and apply_patch), and tool results. Signed thinking blocks are stored as opaque serialized state in Codex rollouts and replayed unchanged; prompt caching is enabled. Start a fresh session when switching model families. Resume an existing Opus session with `cxo resume SESSION_ID`. Unsupported history items, hosted tools, forced tool choice, and structured output modes fail closed. Custom tools use a JSON string wrapper; their Responses grammar is not enforced by Anthropic. Enterprise model policy, authentication and usage accounting still come from the official Copilot runtime.

## Host shell access

Host mode runs Codex directly as the invoking OS user with YOLO enabled: `danger-full-access` and no approval prompts. It can read and write the user's home and other locations permitted by ordinary OS permissions, use host binaries on the inherited PATH, and use the host network. Launching from a project does not restrict access to that directory. Root privileges are not added.

All exported environment variables, including credentials, are inherited. Codex shell policy uses `inherit="all"` and `ignore_default_excludes=true`. The launcher supplies its own `CODEX_HOME` and local model-bridge token. Conversation history stays in `~/.codex-copilot-pilot/codex-home`, so existing Copilot sessions remain available. Shell startup files and managed policies still apply; unexported variables in another shell are not process environment variables.

`cxf` expands to `codex-copilot -- --yolo`. Reload it with `source ~/.bash_aliases` and restart any already-running Docker session to get host access. The host launcher also accepts the former alias's `--network bridge --allow-git-write` flags for compatibility with existing shells. Model traffic still uses the official Copilot SDK through an authenticated loopback bridge; full host mode does not isolate local credentials from Codex's tools.

## SoL-Pi-inspired efficiency

The local efficiency tools adapt ideas from [NVIDIA SoL-Pi](https://github.com/NVlabs/SoL-Pi/tree/e1a586af0ad8956f42ae5b26bba20e48fbf30e00). This is an independent Codex integration, not the Pi extension installed into Codex. It uses Codex's public MCP interface and existing Code Mode; no Rust rebuild or additional inference provider is needed.

```bash
cxf efficiency on      # Enable for subsequent launches (also affects cxo and Docker)
cxf efficiency status  # Local output-byte statistics, including recall overhead
cxf efficiency off    # Disable for subsequent launches; retain evidence
```

The configured machine has this enabled. A fresh `cxf` or `cxo` provides two tools through `sol_efficiency`:

- `run(command, workdir, timeout_ms?, focus?)`: executes a command once, preserving stdout/stderr together in a private archive. Outputs up to 10 KiB remain complete. Larger outputs return bounded, numbered, exact head/tail/diagnostic excerpts, exit status and an archive handle. An optional literal `focus` brings a known target into the first receipt without another model turn.
- `recall(archive, offset?, limit?, contains?)`: retrieves up to 16 KiB of exact text at a time, with byte offsets for pagination and literal search. SHA-256 verification rejects changed archives. The raw file path remains available for native shell access, including binary or exceptionally long output.

The `run` tool's instructions encourage Action Fusion: in one Code Mode call, await a native patch and then run the already-known validation only if the patch succeeds. Fusion depends on the model choosing that sequence; validation is never skipped automatically. Native shell tools remain available, and their output is not intercepted. Savings apply when the agent uses `sol_efficiency`, chiefly for noisy builds, tests and diagnostics; small reads may be cheaper with native tools.

| SoL-Pi mechanism            | Codex adaptation                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Action Fusion               | Native Code Mode sequences patch and validation without an intervening model turn.                                                                                                         |
| ObservationPack             | Compact before the first tool-result insertion, preserving exact local recall. No later history rewrites or prompt-cache-prefix changes.                                                   |
| Evidence-Preserving Reducer | Local exact diagnostic/focus excerpts; no remote summarizer or extra model calls. Excerpts are partial evidence, not semantic summaries or success verdicts.                               |
| Online Context Compact      | Keep Codex's existing native compaction. Pi's plan-boundary compact-and-continue API is unavailable in this launcher; no guessed early-compaction thresholds or hidden continuation calls. |

The model selection, max reasoning and full context settings are unchanged. Opus signed thinking is not rewritten. This deliberately differs from SoL-Pi's two-full-sends projection: the compact receipt is the original tool result in Codex's session history, so resume and compaction do not depend on a transport-side rewrite ledger.

Configuration is `CODEX_HOME/efficiency.json` in the dedicated Copilot state directory. Missing configuration means disabled. Archives and local metrics live in `CODEX_HOME/efficiency-archives`, with private directory/file permissions and no automatic deletion. Exact logs can contain anything the command printed. Host commands inherit the launcher's exported environment; Docker commands stay inside its existing mounts and environment. A full archive (>512 MiB) refuses new commands until old files are moved. Commands are noninteractive, default to a 60-second deadline, allow up to 120 seconds, and are interrupted if observed output exceeds 64 MiB. Interrupted or incomplete capture is explicit; use native exec for background or longer work.

Run the reproducible, zero-inference benchmark with:

```bash
node scripts/copilot-pilot/efficiency/benchmark.mjs
```

The October 2 check returned about 98.1% fewer bytes for three synthetic 257 KiB logs, including receipt and one exact recall, while preserving exit codes and byte-for-byte archives. This is **not** an end-to-end token, billing or model-quality result: it excludes prompts, reasoning, cache pricing and native Codex truncation. The live GPT-6.1 Sol and Opus 5.5 checks recovered a hidden log marker, patched a bug and passed three tests, with patch-and-validation fusion confirmed in the recorded Code Mode calls. Opus resume and inheritance of a synthetic token environment variable also passed.

## Optional Docker isolation

`codex-copilot-docker` retains the previous container launcher, also available directly as `node scripts/copilot-pilot/docker-run.mjs`. It uses a read-only root filesystem, no Linux capabilities, no privilege escalation, only the chosen project and dedicated Codex state writable, and existing `.git`, `.codex`, and `.agents` directories mounted read-only. Codex's inner sandbox is disabled inside the container; Docker supplies the outer restriction. The Node image is pinned by digest.

In Docker mode, GitHub credentials remain outside the container. A private Unix socket and random local bearer connect container Codex to the model adapter. The container receives neither the host home directory nor the Docker socket.

- Tool networking is disabled by default. For tasks requiring package downloads or network tools, explicitly launch with `--network bridge`; it enables container outbound networking.
- Use `--allow-git-write` when the task requires commits or branch changes. Agent configuration directories remain read-only.
- Pass `-- --yolo` to disable Codex approval prompts inside Docker. Docker's outer restrictions still apply.
- The container has its own installed tools. Host-installed tools, MCP servers, plugins and credentials are not automatically imported. This is a Linux launcher, not a drop-in environment clone.

## Model transport limits

- ChatGPT-hosted features are not conferred by a Copilot seat. Copilot-specific governance controls are not automatically equivalent to Codex's controls; enterprise approval of this custom client and its data handling remains an organizational question.
- Access denials and unsupported models fail closed. Inference requests are not retried automatically, upstream HTTP error bodies are suppressed, requests are bounded to 8 MiB, and a disconnected caller cancels inference. TLS verification stays enabled.

The SDK transport hook is experimental and pinned to SDK 1.0.19. Its internal completion acknowledgement preserves the real usage/accounting while preventing the runtime from executing Codex tool calls; only the unmodified upstream output reaches Codex.

## Installation and upstream checks on the configured machine

`~/.local/bin/codex-copilot` points to this checkout's `host-run.mjs` and the installed npm Codex executable bundle. `~/.local/bin/codex-copilot-docker` points to `docker-run.mjs`. The adapter source is used directly; this setup does not build the fork's Rust source. Codex, Copilot CLI, the SDK dependency, and the optional container image have separate versions.

The `codex-copilot-updates.timer` user service checks daily between 10:00 and 10:30 UTC and catches up after downtime. It fetches the official `upstream/main` reference and compares installed Codex, Copilot CLI and SDK versions with their latest stable GitHub releases. Prereleases are excluded. Fetching does not merge source changes or install packages; upgrades need compatibility checks before adopting them.

```bash
cxf update         # Fetch and merge upstream source into this fork, then check runtime releases
cxf update --check # Fetch and check only; no merge or package installation
cxf update --show  # Read the cached report
systemctl --user list-timers codex-copilot-updates.timer
```

Release reminders appear when launching `codex-copilot`, `cx`, or `cxf` in a terminal. Failed checks and reports older than three days also produce a notice. These are local terminal reminders; they do not send email or chat messages. Configuration and results live in `~/.codex-copilot-pilot/update-config.json` and `update-report.json`. The monitor uses public GitHub metadata and does not read Copilot credentials.

`cxf update` always targets the configured harness checkout, regardless of your current project. It requires a clean `main` branch, preserves fork commits through a normal merge, and stops on conflicts without resetting or stashing work. It runs without a model request or Copilot login. Runtime package upgrades remain separate compatibility-tested changes; merging source does not replace the installed Codex binary. The existing `codex-copilot-updates` command remains a check-only alias.

Stop scheduled checks with `systemctl --user disable --now codex-copilot-updates.timer`. To adopt upstream source, first review `git log HEAD..upstream/main`; fetching alone does not update the installed Codex binary.

## Validation

The October 9 maintenance check verified Codex 0.162.1, Copilot CLI 1.0.95, SDK 1.0.19 and host Node 22.23.3 after merging 110 upstream commits. All 43 automated checks passed (one additional optional integration test was skipped). New checks cover active streams exceeding the idle deadline, stalled-stream cancellation, incomplete Responses cleanup, accounting when the client stops reading after completion, and Opus thinking progress.

Live GPT-6.1 Sol and Opus 5.5 sessions used disposable state directories and a test-only 35,000-token compaction threshold. Both automatically compacted, preserved a marker, continued with native apply_patch, passed three tests through the efficiency tool, and verified exported environment and home access outside the launch directory. Both sessions resumed with the normal thresholds and retained the marker. Max reasoning and the full context windows remained enabled. The installed Codex also correctly displayed a synthetic inactivity failure without retrying, and completed a 310-second active stream through the bridge with exactly one request. These two transport checks used local synthetic responses and no Copilot inference. API-key model discovery remains disabled. The optional Docker image was last checked on October 7; its pinned digest is unchanged.

```bash
node --test scripts/copilot-pilot/*.test.mjs
python3 -m unittest discover -s scripts/copilot-pilot -p 'update*_test.py'
```

Live checks on this machine covered real Codex inference, Code Mode file reads, a native apply_patch edit, shell execution, three independently checked tests, and session resume. Automated checks cover byte-preserving forwarding, authentication boundaries, policy/quota errors, cancellation, prevention of a second SDK inference/tool loop, and host launch behavior including environment inheritance and access outside the launch directory. This is a compatibility pilot, not a proof of parity for every Codex feature.

The live host-access check additionally verified the real HOME, reading and writing outside the launch directory, changing to that directory, host Node and Cargo availability, and inheritance of synthetic TOKEN and KEY environment variables without printing real credentials.

The GPT-6.1 Sol default was verified with Codex 0.160.0, Copilot CLI 1.0.91 and SDK 1.0.16: native file reads, apply_patch, and four passing shell-run tests. After correcting Codex's bundled context cap, a further live Code Mode check confirmed 997,500 usable tokens (95% of the configured 1,050,000-token window), max reasoning, and the 875,900-token compaction threshold.

Opus 5.5 was verified with the same runtime versions: Code Mode file reads, an apply_patch edit, three passing shell-run tests, and a resumed session that remembered the fix and reran the tests. Codex's token events confirmed 950,000 usable tokens (95% of the configured 1,000,000-token window), and the provider reported cache hits on the resumed tool loop.

The earlier direct-token experiment remains in `run.mjs`. Its generic endpoint did not expose the needed models for this account; use the SDK launcher above.
