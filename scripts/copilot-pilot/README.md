# Codex with a GitHub Copilot seat

This fork's experimental adapter runs **real Codex**, including Code Mode, its native tool loop, apply_patch, shell commands and session history. The official GitHub Copilot SDK handles the existing CLI login, account routing and model catalog. Its [request handler](https://github.com/github/copilot-sdk/blob/main/nodejs/src/copilotRequestHandler.ts) forwards native GPT Responses requests, translates Claude requests to Anthropic Messages, and adapts Codex custom tools to function tools for Grok and MAI. The native `/model` picker includes every enabled concrete model advertised for a supported streaming tool protocol. Only Codex runs the tools; the SDK does not run a second coding agent.

## Run on Linux

Requires Node.js 22+ (tested with 22.23.3), an authenticated `copilot` CLI (tested with 1.0.100), and the installed Codex executable bundle (tested with 0.163.0). Docker is needed only for the optional container launcher.

```bash
npm ci --prefix scripts/copilot-pilot --ignore-scripts
node scripts/copilot-pilot/host-run.mjs -C /path/to/project
# Arguments after -- go to Codex:
node scripts/copilot-pilot/host-run.mjs -C /path/to/project -- resume --last
```

The configured machine has `codex-copilot` and Bash aliases `cx` and `cxf`, all using the host launcher. Reload the alias and start Codex:

```bash
source ~/.bashrc
cxf                       # Use /model to switch inside Codex
cxf models                # List your seat's models, context and default reasoning
cxf models --json
cxf -m claude-sonnet-5.5   # Select the initial model directly
cxf -m grok-4.7
cxf resume SESSION_ID
```

The October 20 seat check advertised 16 concrete models: GPT, Claude, Grok and MAI. The earlier October 17 catalog contained 21; models removed by the provider are not invented or re-enabled locally. Discovery refreshes on each launch. Explicitly disabled models stay excluded; a missing raw policy field is accepted only when the official SDK also lists the model. The seat's `auto` router does not advertise a concrete context window or transport and is not included as a model with invented limits.

The default remains GPT-6.1 Sol (`gpt-6.1-sol`), max reasoning, and the full advertised context limit. Each model has its own context and compaction metadata, so `/model` does not inherit GPT's window when switching to a smaller model. Other models default to their strongest advertised reasoning effort (`max`, `xhigh`, or `high`); Haiku uses its advertised thinking budget instead of an unsupported effort parameter. For GPT-6.1 Sol, the Copilot catalog currently advertises 1,050,000 total context tokens, with a 922,000-token input limit and 128,000-token output limit. Auto-compaction retains headroom at 95% of the input limit (875,900 tokens). Limits are read from the provider catalog at launch. For advertised windows of at least one million tokens, the SDK session explicitly selects `contextTier="long_context"`; its `reasoningEffort` follows the Codex request. This uses the official runtime's context-tier selection rather than relying only on Codex's token-window override. `--model`, `--reasoning`, `--state-dir`, `--copilot-bin`, and `--codex-bin` override these choices. The Codex binary must retain its companion executables, including `codex-code-mode-host`. Changes to Rust are unnecessary for this transport integration.

All launchers explicitly set `features.api_key_model_discovery=false`. Codex 0.161 enables API-key model discovery by default, but this bridge implements Responses rather than Codex's discovery endpoint. The Copilot SDK still checks the seat's enabled model catalog and context limits at every launch. This setting applies to `cxf`, `cxo`, the direct launcher, and Docker; verify it with `cxf features list`.

### Native session switching

Use `/model` in an existing `cxf` session. Visible conversation, structured native tool calls and results, call/result IDs, filesystem changes and native session storage remain available to the destination. A normal switch retains the original history rather than replacing it with a handoff summary. Each model receives its own advertised context window and supported reasoning settings. Claude, Grok and MAI can use native direct tools alongside Code Mode, so a direct shell or patch call in an earlier model's history does not force the next model into a different tool convention.

Opaque reasoning is stored with durable model ownership in native rollouts. New GPT reasoning uses the `copilot-model-state-v3:` envelope: a small model tag surrounding unchanged provider bytes, not new encryption or a decryption key. GPT-to-GPT switches now restore those exact bytes, including after a bridge restart or a switch away and back. The [OpenAI reasoning protocol](https://developers.openai.com/api/docs/guides/reasoning) lets compatible GPT models reuse earlier reasoning and omits incompatible family state from the sampled context. Controlled Copilot requests confirmed `reasoning.context="all_turns"` with max effort on GPT-5.6 Sol/Luna, GPT-6 Sol and GPT-6.1 Sol; the adapter keeps each model's server defaults rather than forcing an unsupported context mode on older models.

Claude signed thinking retains its exact block and response boundary. Claude-to-Claude switches replay the complete signed blocks natively, following [Anthropic's preserved-thinking protocol](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking). Compatible destination models can use them; the API enforces model/account binding and drops blocks the destination cannot read. The adapter does not decrypt or turn signed reasoning into message text. Thinking-only responses remain separate; merging them would invalidate provider signatures. Cross-provider private reasoning stays archived and is omitted from incompatible wire requests. Old raw GPT ciphertext without a durable owner is also retained on disk and omitted on the wire rather than guessing its provider after restart. Grok rejects replay of its own opaque reasoning, so it remains archived while visible history continues normally.

The adapter normalizes provider-specific optional tool item IDs only in outgoing GPT requests; `call_id`, arguments and results remain linked and the native archive is unchanged. Collaboration schemas are adapted in both standard Responses tools and newer GPT Responses Lite `additional_tools` declarations.

If a conversation is too large for a smaller destination, installed Codex compacts it using the **source model before switching**. Models with equal total windows can also have different input allowances or output reserves. For those native compaction requests, the adapter uses saved model ownership to keep summarization with an authorized source that has the larger input budget. It preserves the native request, summary and accounting; no extra model call or tool loop is added. Unknown ownership never selects a guessed model. The complete raw conversation remains in native session storage, while the smaller model receives the checkpoint and subsequent history. A smaller window cannot hold an arbitrarily larger raw conversation; no encryption adapter can change that limit. Sessions created before this format may receive a one-time source-model compaction during migration.

Provider-private state is not universally portable across model keys/accounts. The original October 20 matrix had seven failed transitions into `claude-opus-5`; seamless switching across every model is **not yet achieved**. Follow-up inspection found Anthropic's `stop_details.category="reasoning_extraction"` in native continuation probes. An earlier official-CLI comparison checked that the task completed but did not verify the served model. A subsequent wire-level control reproduced the refusal in the official runtime itself, followed by an automatic switch to `claude-opus-4.8` with `cause="refusal_fallback"`; Opus 4.8 completed the task. Successful CLI output therefore does not prove that Opus 5 accepted that conversation. Lowering output limits, changing thinking display, moving later system instructions, or omitting completed signed thinking did not establish a reliable fix. Limits and max reasoning have not been reduced. The bridge preserves the selected model rather than silently counting another model's answer as its success. After a refusal, `/model claude-opus-4.8` or another enabled model can continue the saved native conversation. The [earlier diagnostic report](validation-2026-10-20-refusal.json) retains the initial findings; the wire-level correction supersedes its unverified official-CLI model attribution.

Anthropic refusals now produce a terminal, non-retryable error with the provider's category and explanation, rather than a fabricated successful answer saying only "The model declined this request." Real token and billing accounting is retained, including for refusals after partial output. Metadata diagnostics record only an allowlisted category. [Anthropic documents](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback) that `reasoning_extraction` can originate in system instructions or tool schemas and recommends using native thinking blocks instead of asking for private reasoning in text. The adapter neither decrypts private reasoning nor automatically resubmits refusals. Large-context probes also observed provider HTTP 503 `model_overloaded` and an upstream EOF; advertised maximum windows are configured, but remote capacity and uninterrupted inference cannot be guaranteed.

### Streaming and compaction

Active Responses requests have no adapter-imposed total-duration deadline. The bridge cancels after five minutes without upstream bytes; Codex's own SSE inactivity limit is six minutes so the bridge can report its error first. Opus thinking activity emits progress events while preserving signed thinking. A stalled or truncated stream cancels the outstanding request and releases the SDK session. Codex can reconnect up to three times per sampling request, using its current conversation history and completed tool results. Unbounded connection retries are disabled. The bridge and SDK do not retry or execute tools themselves, and never fabricate a completion. Upstream HTTP 4xx responses become terminal Responses rejections; authentication, policy, quota and compatibility denials are not retried. Server and transport failures use the bounded native recovery path.

SSE event mappings now use Web Streams directly so cancellation propagates to an upstream reader still waiting for bytes. The former async-generator/Node-stream conversion leaked those reads: a controlled nested-map cancellation test released 0/50 upstream readers, while the corrected implementation releases 50/50. A live validation run also exposed an unhandled `Controller is already closed` failure in that conversion path. Messages output no longer crosses the same Node-stream adapter. These changes fix the reproduced cleanup defect; they do not guarantee that a remote service never disconnects.

The private acknowledgement back to the official runtime also uses streaming SSE, with `streaming=true` on the SDK session. Buffered JSON acknowledgements in Copilot CLI 1.0.95 and 1.0.96 were cancelled at exactly 600 seconds, even when JSON whitespace arrived throughout the request. A controlled comparison with CLI 1.0.83 completed after 660 seconds. Switching the acknowledgement to proper protocol events removes that reproduced cutoff without changing authentication, reasoning or context limits. Progress reflects actual upstream bytes; no periodic fabricated activity hides a stalled provider. Only a real provider terminal event releases the final acknowledgement and its real token/billing data. Codex receives native GPT events with portable collaboration names restored, and translated Opus events, and the SDK never executes Codex tools.

Successful HTTP response cleanup does not cancel a pending runtime acknowledgement. A real terminal frame is sufficient for accounting; the adapter does not wait for a provider to close its socket. Shutdown allows up to three seconds for completed acknowledgements to settle, then cancels remaining work. Opus streams no longer have an 8 MiB cumulative wire limit: SSE overhead is independent of decoded model output. Individual SSE events in both protocols have a 32 MiB bound; Opus's accumulated decoded output has a separate 32 MiB bound. Large network chunks containing many small GPT events are parsed per event instead of being rejected as one oversized event. In-stream Opus size failures enter native context-limit handling, server errors retain bounded recovery, and quota, authentication, policy or unknown denials stop without retries.

Each sampling request creates a temporary SDK session containing only the internal forwarding prompt and accounting acknowledgement. After idle or cancellation, the bridge deletes that newly created SDK session through the official API. The former `disconnect()` cleanup preserved its files indefinitely. Native Codex session IDs, rollouts and project files use separate storage and are never passed to this cleanup. A failed deletion records metadata and falls back to disconnecting the temporary session.

A provider `response.failed` or `response.incomplete` event is preserved instead of being replaced by a generic disconnect. An `interrupted` response uses Codex's native continuation protocol and retains its real accounting. Generic provider error events are classified for Codex; unknown generic rejections stop without retrying.

Responses and Messages stream failures write metadata to `CODEX_HOME/stream-diagnostics.jsonl`: time, model, context tier, reasoning effort, request size, elapsed milliseconds, event/byte counts, allowlisted error codes and which cancellation signal fired. Messages diagnostics also identify the last protocol event, block type, stop reason and a malformed tool name when applicable. Prompts, tool outputs, credentials, raw error messages and reasoning content are excluded. The private log stops appending at 1 MiB; move it aside to start a fresh log. Diagnostics failure never interrupts inference.

The October 9 investigation found two GPT requests interrupted almost exactly 300 seconds after the preceding tool result, with about 265k and 388k input tokens. The original bridge timer and SDK `sendAndWait` each imposed a five-minute total limit. These limits predated the API-key discovery change; they have been replaced with inactivity and session-lifecycle handling. The Copilot provider uses HTTP streaming with WebSockets disabled. The separate `websocket closed by server before response.completed` message from regular Codex is outside this bridge.

Later October 9 failures occurred after about 47 and 97 seconds, with reasoning still arriving and context below the compaction threshold. The prior error handler discarded the underlying error, so those logs cannot establish the original trigger. Two additional adapter problems were verified: native stream recovery was disabled, and the Responses observer treated legitimate non-completed terminal events as truncated streams. The follow-up change enables bounded recovery, preserves terminal events and records diagnostic metadata. No context or reasoning settings were reduced.

Compaction uses Codex's native local summarization through the normal model endpoint. The provider explicitly sets `capabilities.remote_compaction="unsupported"`, since the bridge does not implement the new remote compaction protocol. `model_auto_compact_token_limit_scope="total"` counts the whole context. GPT's 875,900-token and Opus's 828,400-token thresholds retain output headroom; the full context windows and max reasoning defaults are unchanged. Compaction itself can take time and obeys the same inactivity watchdog.

Requests have a separate 32 MiB byte ceiling, matching the [Copilot Responses limit introduced in CLI 1.0.74](https://github.com/github/copilot-cli/issues/4183#issuecomment-5088784470). The previous local 8 MiB cap could block long histories below their token-based compaction threshold, especially with opaque reasoning state. Local size failures and upstream HTTP 413 responses now produce an explicit `context_length_exceeded` failure. Codex marks context full and runs native local compaction before the next turn instead of reconnecting with the same oversized request. Both declared-length and chunked uploads enforce the byte ceiling. Model discovery retains its independent 8 MiB bound.

Restart existing `cxf` and `cxo` processes after upgrading to load the updated adapter and binary. Existing sessions can then be resumed normally.

### Opus 5.5 option

```bash
source ~/.bash_aliases
cxo  # Claude Opus 5.5, max reasoning, full context, host YOLO mode
# Equivalent explicit launcher:
codex-copilot --model claude-opus-5.5 --reasoning max
```

`cxf` still defaults to GPT-6.1 Sol. Opus uses the seat's enabled `claude-opus-5.5` model with a 1,000,000-token window and up to 128,000 output tokens. Compaction starts at 828,400 tokens, retaining output space and 5% input headroom. A temporary Codex model catalog sets the actual context cap, so Codex's bundled or unknown-model limits cannot silently reduce the selected model's window. Known GPT metadata retains its bundled instructions and tools with the Copilot catalog's context limits.

The Claude translation supports text, images, function tools, namespaced tools, custom tools (including Code Mode and apply_patch), and tool results. Signed thinking blocks are stored as opaque serialized state in Codex rollouts and replayed unchanged to the Claude API for its compatibility checks; prompt caching is enabled. Switching providers preserves visible conversation and completed tool results, while foreign private reasoning is omitted. Grok and MAI use function-tool wrappers; non-GPT opaque Responses reasoning is marked in saved history and omitted on replay so it cannot be sent to an incompatible model. Grok also rejects its own opaque reasoning when replayed as input. Tool-call IDs remain linked to their completed results. Resume an existing Opus session with `cxo resume SESSION_ID`. Unsupported history items, hosted tools, forced tool choice, and structured output modes fail closed. Custom tools use a JSON string wrapper; their Responses grammar is not enforced by Anthropic. Enterprise model policy, authentication and usage accounting still come from the official Copilot runtime.

### Agent task compatibility

The October 20 investigation traced repeated Opus subagent failures to local request translation: Codex supplied `agent_message` history, which the Messages adapter previously rejected before contacting Copilot. Plaintext agent messages now retain their entire text and sender/recipient attribution when translated to Claude or another Responses provider.

New collaboration tasks use ordinary custom function tools under the wire namespace `copilot_collaboration`. OpenAI's native `collaboration.*` namespace reserves an encrypted schema, so the adapter gives the portable tools distinct names and maps their calls back to Codex. Only the message schema's encryption annotation is removed; other tool schemas and native tool execution are retained. Completed plaintext calls explicitly carry `encrypted_function_args=[]`, selecting Codex's native plaintext delivery and log-redaction path. The SDK still executes no tools. Prompts and task text have the normal visibility of other model input and local session history.

Existing OpenAI-encrypted agent messages cannot be translated or decrypted by Claude/Grok/MAI. They stop with an explicit, non-retryable compatibility error before upstream inference; their instructions are never silently omitted. Restart `cxf`, create a new Opus task from its parent, and resend the task instructions in plaintext. Ordinary Opus conversations and their signed thinking remain resumable. No decryption keys, enterprise policy, authentication or accounting checks are bypassed.

### Adaptive thinking and reasoning effort

GPT-6.1 Sol uses fixed reasoning effort levels; [OpenAI documents](https://developers.openai.com/api/docs/guides/latest-model#gpt-61-sol) `low`, `medium`, `high`, `xhigh`, and `max`. The October 10 enterprise runtime check rejected actual inference with `adaptive` or `auto` effort. Session creation alone accepted and echoed these strings, so that acknowledgement does not establish inference support. GPT remains at `max`, as requested when adaptive effort is unavailable.

Opus already sends `thinking={type:"adaptive"}` alongside `output_config={effort:"max"}`. [Anthropic documents](https://platform.claude.com/docs/en/build-with-claude/effort#effort-with-thinking) adaptive thinking as a separate control from effort; `adaptive` is not an effort value. The Copilot runtime also rejected Opus inference with `adaptive` effort. Its `max` default remains unchanged.

## Host shell access

Host mode runs Codex directly as the invoking OS user with YOLO enabled: `danger-full-access` and no approval prompts. It can read and write the user's home and other locations permitted by ordinary OS permissions, use host binaries on the inherited PATH, and use the host network. Launching from a project does not restrict access to that directory. Root privileges are not added.

All exported environment variables, including credentials, are inherited. Codex shell policy uses `inherit="all"` and `ignore_default_excludes=true`. The launcher supplies its own `CODEX_HOME` and local model-bridge token. Conversation history stays in `~/.codex-copilot-pilot/codex-home`, so existing Copilot sessions remain available. Shell startup files and managed policies still apply; unexported variables in another shell are not process environment variables.

`cxf` expands directly to `codex-copilot`, whose host launcher defaults to YOLO. Reload it with `source ~/.bashrc` and restart any already-running Docker session to get host access. The host launcher also accepts the former alias's `--network bridge --allow-git-write` flags for compatibility with existing shells. Model traffic still uses the official Copilot SDK through an authenticated loopback bridge; full host mode does not isolate local credentials from Codex's tools.

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

The October 10 check saved `enabled=true` in the default state directory and verified that subsequent launch arguments register `sol_efficiency` as a required MCP server. This local tool-output efficiency setting is independent of reasoning effort. Copilot's [Auto efficiency tier](https://docs.github.com/en/copilot/concepts/models/auto-model-selection#auto-tier-options) routes between models; this adapter keeps the explicitly selected GPT or Opus model.

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
- Access denials and unsupported models fail closed. The adapter forwards each request once; Codex owns the bounded stream recovery described above. Upstream HTTP error bodies are suppressed, inference requests are bounded to 32 MiB, and a disconnected caller cancels inference. Size failures enter Codex's context-limit handling. TLS verification stays enabled.

The SDK transport hook is experimental and pinned to SDK 1.0.22. Its internal completion acknowledgement preserves the real usage/accounting while preventing the runtime from executing Codex tool calls. Native GPT Responses output retains its content and accounting, with portable collaboration metadata and durable ownership around opaque reasoning; Grok and MAI tool events are translated to Codex custom-tool events. Generic protocol errors can be classified into Responses failure events.

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

The October 20 switching checks ran on Codex 0.163.0, Copilot CLI 1.0.100 and SDK 1.0.22. The [machine-readable report](validation-2026-10-20.json) contains all transition results, model limits and unresolved provider failures.

| Check | Result |
| --- | --- |
| Live native switching, including exact retained tool history, shell use and patched files | 249/256 passed; all seven remaining cases were explicit `claude-opus-5` provider refusals |
| Synthetic near-limit matrix through the installed native engine | 256/256 passed, including 104 compactions with source affinity checked |
| Real-provider compaction across unequal input budgets | 2/2 passed; only the native client's reported token counts were simulated |
| Fresh-process resume, switch away, switch back | 15/16 models passed all three stages; Opus 5 declined the resumed conversation |
| Advertised reasoning configurations | All 76 accepted by real inference; marker compliance is reported separately |
| Physical large-context requests | 10/16 completed at about 93–94% of input allowance; nine retrieved both markers; the other GPT requests encountered upstream overload or EOF |
| Regular checks | 82 Node checks, nine native recovery/size checks and seven updater checks passed; 11 opt-in checks skipped in the regular Node run |

The provider failures remain visible. These results establish the tested native session/tool compatibility; they do not guarantee that every provider accepts every conversation or maximum-size request.

The later [native-state and stream-cleanup report](validation-2026-10-20-native-state.json) covers the updated replay behavior:

| Current follow-up check | Result |
| --- | --- |
| Every GPT-to-GPT native transition, original opaque state and actual model checked | 49/49 passed; 161 original reasoning items forwarded |
| Every Claude-to-Claude native transition, original signed state and actual model checked | 33/36 passed; three Opus 5 `reasoning_extraction` refusals |
| All-provider synthetic near-limit matrix | 256/256 passed, including 104 source-affinity compactions |
| Fresh processes: resume, switch providers, switch back | 3/3 generated sessions passed all nine stages |
| Stream cancellation with upstream left open | 50/50 readers released; the earlier implementation released 0/50 |
| Regular and native regression checks | 88 regular checks passed, 11 opt-in checks skipped; 12 native recovery, size and runtime checks passed |

The official-runtime control also refused an Opus 5 request and completed the task after changing to Opus 4.8. It records task recovery separately from requested-model success. Physical maximum-window capacity was not rerun in this follow-up. A root-filesystem exhaustion interrupted two validation runs; their partial results are excluded, and both complete matrices were rerun on the data volume. Generated validation artifacts were archived with their original paths preserved; existing user sessions were not moved or stopped.

Current matrix reports also verify the model reported in GPT and Claude responses, accept Anthropic's documented dotted/hyphenated IDs and Haiku 4.5 snapshot alias, and reject an answer from a different model as proof for the requested one. They check that saved GPT reasoning items and Claude thinking blocks reach their destination requests byte-for-byte, alongside the existing tool-history and filesystem checks.

The opt-in model matrix uses the installed native Codex app-server, the official Copilot runtime and generated test files. Each source reads a private random marker with a shell tool and applies a real patch. Every destination forks that native session, reads a new marker with a native shell tool, recalls the old marker and verifies the patched artifact. It checks structured call/result history and the destination's native context metadata. The synthetic mode replaces only model inference, reports near-window token usage and exercises source-model compaction through the same native tool engine; it is not a real capacity measurement. Both modes cover the current catalog's 16 × 16 transitions. `--live --near-limit` uses real model inference but simulates near-limit usage only for the isolated native test client; the SDK retains genuine accounting. It checks real signed-state and compaction compatibility without constructing a huge prompt. The restart check starts fresh native and runtime processes, resumes generated sessions and switches away and back. Separate capability checks exercise every advertised reasoning level; `--context` sends generated input near advertised limits and can consume substantial seat credits. Reports distinguish API acceptance from marker retrieval or model refusals. Refusals, overloads and failed attempts are retained rather than silently retried until green.

```bash
export COPILOT_PILOT_CODEX_BIN=/absolute/path/to/native/codex
export COPILOT_PILOT_RUNTIME_BIN=/absolute/path/to/copilot
node scripts/copilot-pilot/model-switch-check.mjs --live --out /private/new-matrix --jobs 3
node scripts/copilot-pilot/model-switch-check.mjs --synthetic --out /private/new-compaction-matrix --jobs 4
node scripts/copilot-pilot/model-capabilities-check.mjs --live --reasoning --out /private/new-reasoning-check
# Optional, substantially larger real requests:
node scripts/copilot-pilot/model-capabilities-check.mjs --live --context --out /private/new-context-check
```

These checks never start subagents, execute tools through the SDK or modify existing user sessions. Restart tests require an explicitly supplied manifest of generated test sessions, including their native state directories, thread IDs, artifact paths and expected generated markers.

For a separate official-runtime comparison, this opt-in control deliberately uses Copilot's own `bash`, `view` and `edit` tools in generated files. It records requested and served models, refusal categories and runtime model-change events without saving prompts, thinking, credentials or fallback-credit tokens. It returns a failure when the task succeeds only after switching to a different model:

```bash
COPILOT_PILOT_RUNTIME_BIN=/absolute/path/to/copilot \
  node scripts/copilot-pilot/runtime-model-check.mjs --live \
  --model claude-opus-5 --out /private/new-official-control
```

The October 20 maintenance synchronized upstream source and installed verified Copilot CLI 1.0.100. Codex 0.163.0 and SDK 1.0.22 remained the latest stable versions. Before the fix, a fresh Opus shell-tool check succeeded while the recorded Opus agent threads repeatedly failed with generic local HTTP 502 errors. The `agent_message` incompatibility was reproduced directly. After the fix, installed Codex resumed a synthetic Opus session containing a plaintext agent task, read its hidden task marker, used shell commands, and applied a real patch. Live GPT, Opus and Grok protocol checks emitted plaintext collaboration calls while preserving exact task text and real accounting, without executing agent tools. Opus 5 and Opus 4.8 also resumed that test conversation and used shell tools. All 69 regular Node checks, nine native recovery/compaction checks and seven updater checks passed. These include namespace restoration, non-GPT tool conversion, encrypted-task rejection and metadata-only diagnostics. Encrypted-task rejections stop after one native request. Both 660-second synthetic full-bridge stream tests passed on Copilot CLI 1.0.100, each with one backend request, one runtime request, an accepted accounting acknowledgement and no reconnects.

The October 17 update merged upstream through `ce0323f2f2d3` and upgraded Codex to 0.163.0, Copilot CLI to 1.0.98 and SDK to 1.0.22. All 21 concrete seat models completed live inference with their strongest supported reasoning settings. The native picker listed all 21 with GPT-6.1 Sol as default. Real same-thread model switches across GPT, Claude, Grok and MAI retained a saved marker and executed shell tools. The recorded context window changed with each model rather than retaining GPT's global override. Both 660-second synthetic full-bridge stream tests and all eight native recovery/compaction checks passed on these versions. Regular unit checks cover the catalog, tool conversion, reasoning provenance, CLI arguments and existing byte/stream limits.

The October 13 size investigation found about 9.1 MB of serialized response history since the last compaction in the affected session, with the last request using 360,118 input tokens. The old 8 MiB bridge cap explains that local rejection independently of the token window. Boundary checks forward 9 MiB and exactly 32 MiB unchanged, reject declared and chunked uploads above 32 MiB before upstream inference, and redact upstream HTTP 413 bodies. An installed-Codex check verifies that a size rejection is not stream-retried and that resuming the same synthetic session performs native local summarization before continuing.

The October 13 stream investigation separately reproduced the 600-second runtime cancellation and retained its explicit `request timed out` reason. Short checks alone did not catch it. The optional `sdk-runtime.test.mjs` exercises installed Codex, the actual Copilot runtime, and the local bridge for 660 seconds per model, with max reasoning and long context. It requires `COPILOT_PILOT_CODEX_BIN` and `COPILOT_PILOT_RUNTIME_BIN`; model discovery uses the logged-in seat, while every inference POST is synthetic and never reaches a model backend. It asserts one inference request, successful native completion, runtime acknowledgement acceptance and no reconnects. `COPILOT_PILOT_LONG_STREAM_MS` permits short protocol checks; those do not establish that the ten-minute regression is fixed.

Validation with installed Codex 0.162.1, Copilot CLI 1.0.96 and SDK 1.0.19 passed both 660-second full-bridge runs, 49 regular Node checks and eight native recovery/compaction checks. Both long runs completed with exactly one backend request, one runtime request and an accepted runtime acknowledgement. Separate live GPT and Opus inference checks confirmed long context, max reasoning, real completion and no extra runtime inference attempts. The legacy optional tool-loop integration check remains skipped. This establishes the reproduced bridge cutoff and byte-limit recovery fixes; transient failures in the remote service or network still use bounded native recovery.

```sh
COPILOT_PILOT_CODEX_BIN=/absolute/path/to/codex \
COPILOT_PILOT_RUNTIME_BIN=/absolute/path/to/copilot \
node --test scripts/copilot-pilot/sdk-runtime.test.mjs
```

The October 10 check followed GitHub's [context-window documentation](https://docs.github.com/en/copilot/reference/ai-models/supported-models#models-with-extended-capabilities). The official runtime reported no explicit tier when the adapter omitted it, and reported `long_context` with `max` reasoning when those options were selected. After aligning the SDK session with the Codex request, both GPT-6.1 Sol and Opus 5.5 completed a short live inference check. A live Opus check also exposed Copilot's `[DONE]` SSE trailer, which the Messages translator previously tried to parse as JSON. The translator now accepts that trailer only after a genuine `message_stop`; a premature trailer remains a failed stream. The 13 SDK and streaming checks passed. This confirms the settings are applied; it does not establish that the historical stream failures were caused by tier selection.

The follow-up validation passed 41 regular Node checks, seven native recovery checks and seven updater checks; the legacy optional tool-loop integration test was not run. The recovery checks use installed Codex 0.162.1 against synthetic streams. They cover disconnects before and after tool execution, continuation after `response.incomplete`, exhaustion of the three-reconnect limit, and no retries for HTTP 403, quota or generic policy denials. After a forced disconnect following a shell side effect, the recovered request included the completed tool result and the command executed exactly once.

Live GPT-6.1 Sol and Opus 5.5 checks injected a socket failure into the official SDK's upstream response. Both displayed `Reconnecting... 1/3`, continued with real inference and native shell tools, and appended their test marker exactly once. A separate max-reasoning request with 239,084 input tokens completed after 145 seconds. These checks demonstrate recovery under injected faults; the historical generic errors do not identify their original network or provider cause.

Run the zero-inference native recovery tests with the installed binary:

```bash
COPILOT_PILOT_CODEX_BIN=/absolute/path/to/native/codex node --test scripts/copilot-pilot/recovery.test.mjs
```

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
