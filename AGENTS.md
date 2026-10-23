# Harness maintenance

When the user asks to update this fork, complete the runtime update and reload
the running Screen sessions. A source fetch or changed package pin alone does
not update a process that is already running.

- Start on a clean `main`. Preserve unrelated user changes. Commit the changes
  made for the current repair before synchronizing upstream.
- Run `cxf update` (`cxf update --all` is equivalent). It synchronizes upstream,
  verifies and stages stable Codex/Copilot/Node runtimes, updates the SDK, runs
  checks, and reloads the exact native root thread in each existing Screen shell.
  `cxf update --check` remains read-only; `--sync` synchronizes source only.
- Inspect the private update report and verify the actual replacement processes,
  original thread and goal IDs, selected model/reasoning, and active or paused
  state. Never use `resume --last` as a substitute for an identified thread.
- The controlling Codex session reloads last through a separate supervisor that
  waits for its turn to finish. Complete and commit the work before yielding to
  that handoff. The resumed controller must verify the handoff report and finish
  the user's request without repeating completed updates or healthy reloads.
- Preserve explicit user pauses, completed goals, native budgets, pending input,
  and running compaction. A request to reassess strategy periodically and then
  proceed does not require manual approval and must not become a watcher gate.
- Do not start a concurrent writer to a thread. Quit its old writer and launcher
  gracefully before resuming in the same Screen shell, preserving the environment.
- Verify fresh tool results for repaired failures. Old errors in scrollback are
  not evidence that the replacement process failed.
- Treat errors by their observed cause. Recognized context-overflow 400/413
  responses enter native compaction. Auth/policy/quota/TLS/refusal errors and
  unreadable encrypted outputs are not context errors or reasons for blind retry.
- Never decrypt, silently discard, or invent encrypted agent instructions or
  reports. A narrowly configured recovery of rejected historical progress must
  keep the original native records, explicitly mark the missing progress, and
  verify that the exact same author's plaintext final report is already present
  in the request. Unknown ciphertext remains protected.
- Run the appropriate bridge/native and maintenance checks. Save a concise
  validation report without private goals, credentials, prompts, or ciphertext.
  Commit and push authorized harness changes to the user's fork as `achbogga`.

Runtime binaries are installed in immutable version directories. Keep the full
Codex bundle, including `codex-code-mode-host`. Private runtime/config backups,
Screen captures, recovery maps and update reports belong outside this repository.

If a failed launcher prevents `cxf update` from starting, invoke the underlying
`scripts/copilot-pilot/update_all.py --config <private update-config.json>` with
Python 3.12 directly and inspect its report before retrying.
