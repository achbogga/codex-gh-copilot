import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkModelSwitches } from "./model-switch-check.mjs";

test("installed harness switches Sol 6.1 to Sol/Astra 6.2 and back on one native writer with shell, patches and full history", {
  skip: !process.env.COPILOT_PILOT_CODEX_BIN || !process.env.COPILOT_PILOT_RUNTIME_BIN,
  timeout: 90000,
}, async (t) => {
  const out = await mkdtemp(join(homedir(), ".copilot-same-thread-"));
  t.after(() => rm(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const destinations = ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol"];
  const report = await checkModelSwitches({ out,
    codexBin: process.env.COPILOT_PILOT_CODEX_BIN,
    copilotBin: process.env.COPILOT_PILOT_RUNTIME_BIN,
    from: ["gpt-6.1-sol"], to: destinations, sameThread: true, synthetic: true, jobs: 1 });
  const source = report.results.find(r => r.kind === "source");
  const pairs = report.results.filter(r => r.kind === "pair");
  assert.equal(report.failed_pairs, 0);
  assert.equal(report.passed_pairs, destinations.length);
  assert.deepEqual(pairs.map(r => r.target), destinations);
  assert.deepEqual(pairs.map(r => r.source), ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.2-astra"]);
  for (const row of pairs) {
    assert.equal(row.thread_id, source.thread_id);
    assert.equal(row.native_pid, source.native_pid);
    assert.equal(row.same_thread, true);
    assert.equal(row.history, true);
    assert.equal(row.tools, true);
    assert.equal(row.patch, true);
    assert.equal(row.full_history, true);
  }
});
