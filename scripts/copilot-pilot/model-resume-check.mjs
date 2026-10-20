import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSdkTransport } from "./sdk-transport.mjs";
import { listModels, startBridge } from "./bridge.mjs";
import { catalogArguments, reasoningForModel } from "./model-config.mjs";
import { codexInvocation } from "./run.mjs";
import { nativeCheck } from "./native-check.mjs";

// Resume only explicitly supplied generated test sessions. A fresh runtime and
// native process for each case proves provenance survives a bridge restart.
const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    manifest: { type: "string" },
    out: { type: "string" },
  },
});
assert.ok(
  values.live &&
    values.manifest &&
    values.out &&
    process.env.COPILOT_PILOT_RUNTIME_BIN &&
    process.env.COPILOT_PILOT_CODEX_BIN,
  "Pass --live --manifest GENERATED_TEST_MANIFEST --out PRIVATE_DIRECTORY and both runtime binary environment variables.",
);
const cases = JSON.parse(await readFile(values.manifest, "utf8"));
assert.ok(cases.length);
const out = resolve(values.out),
  results = [];
await mkdir(out, { recursive: true, mode: 0o700 });
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(2, cases.length) }, async () => {
    while (next < cases.length) {
      const entry = cases[next++],
        start = Date.now();
      const root = join(out, entry.model);
      await mkdir(root, { mode: 0o700 });
      let sdk, bridge, native;
      const stages = [];
      try {
        sdk = await createSdkTransport({
          cliPath: process.env.COPILOT_PILOT_RUNTIME_BIN,
          directory: root,
          diagnosticFile: join(root, "diagnostics.jsonl"),
        });
        const models = await listModels(
          async () => "sdk-owned",
          sdk.transport,
          { messages: true, runtimeModelIds: sdk.models.map((m) => m.id) },
        );
        const source = models.find((m) => m.id === entry.model);
        assert.ok(source, "Source model is no longer advertised.");
        const target = models.find(
          (m) =>
            m.id ===
            (entry.model.startsWith("gpt-")
              ? "claude-opus-5.5"
              : "gpt-6.1-sol"),
        );
        assert.ok(target);
        const localToken = randomBytes(24).toString("hex");
        bridge = await startBridge({
          getToken: async () => "sdk-owned",
          localToken,
          models,
          model: source.id,
          transport: sdk.transport,
        });
        const invocation = codexInvocation({
          model: source.id,
          url: bridge.url,
          localToken,
          stateDir: entry.state,
          args: [
            ...(await catalogArguments(
              models,
              source,
              "max",
              join(root, "models.json"),
            )),
            "--yolo",
            "app-server",
            "--listen",
            "stdio://",
          ],
        });
        native = await nativeCheck({
          binary: process.env.COPILOT_PILOT_CODEX_BIN,
          invocation,
          cwd: entry.project,
          stderrFile: join(root, "native.stderr"),
        });
        await native.rpc("thread/resume", {
          threadId: entry.thread_id,
          model: source.id,
          cwd: entry.project,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          excludeTurns: true,
        });
        for (const [stage, model] of [
          ["restart-resume", source],
          ["switch-away", target],
          ["switch-back", source],
        ]) {
          const proofMarker = "RESUME_TOOL_" + randomBytes(8).toString("hex");
          const proof = join(root, `${stage}.txt`);
          await writeFile(proof, proofMarker + "\n", { mode: 0o600 });
          const result = await native.turn(
            entry.thread_id,
            model.id,
            `Continue this generated regression test. Read ${proof} and ${entry.artifact} with a shell tool. Reply with the exact original MATRIX_HISTORY_ token from the saved conversation, the RESUME_TOOL_ token just read, and the PATCH_AFTER_ value from the artifact. Do not read seed files, spawn agents or change files.`,
            reasoningForModel(model),
          );
          assert.equal(
            result.turn.status,
            "completed",
            JSON.stringify(result.turn.error),
          );
          const items = result.events
            .filter((e) => e.method === "item/completed")
            .map((e) => e.params.item);
          const text = items
            .map((i) => i.text ?? "")
            .join("\n")
            .replace(/[`*\s]/g, "");
          assert.ok(
            text.includes(entry.history_marker),
            `${stage}: original history missing.`,
          );
          assert.ok(
            text.includes(proofMarker),
            `${stage}: fresh tool result missing.`,
          );
          assert.ok(
            text.includes(
              `PATCH_AFTER_${entry.model.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
            ),
            `${stage}: patched artifact state missing.`,
          );
          assert.ok(
            items.some((i) =>
              ["commandExecution", "mcpToolCall"].includes(i.type),
            ),
            `${stage}: no native shell tool.`,
          );
          stages.push({ stage, model: model.id, passed: true });
        }
        results.push({
          model: entry.model,
          passed: true,
          stages,
          elapsed_ms: Date.now() - start,
        });
      } catch (error) {
        results.push({
          model: entry.model,
          passed: false,
          stages,
          error: error.message.slice(0, 1500),
          elapsed_ms: Date.now() - start,
        });
      } finally {
        await native?.close();
        await bridge?.close();
        await sdk?.close();
      }
      const row = results.findLast((r) => r.model === entry.model);
      await appendFile(join(out, "results.jsonl"), JSON.stringify(row) + "\n", {
        mode: 0o600,
      });
      console.log(JSON.stringify(row));
    }
  }),
);
assert.equal(results.length, cases.length);
await writeFile(
  join(out, "report.json"),
  JSON.stringify({ finished: new Date().toISOString(), results }, null, 2),
  { mode: 0o600 },
);
process.exitCode = results.some((r) => !r.passed) ? 1 : 0;
