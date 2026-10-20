import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createSdkTransport } from "./sdk-transport.mjs";
import { listModels, startBridge } from "./bridge.mjs";
import {
  catalogArguments,
  reasoningForModel,
  modelInputLimit,
} from "./model-config.mjs";
import { codexInvocation } from "./run.mjs";
import { nativeCheck } from "./native-check.mjs";
import { switchFixture } from "./switch-fixture.mjs";
import { mapResponseEvents } from "./responses-events.mjs";

const textOf = (result) =>
  result.events
    .filter((e) => e.method === "item/completed")
    .map((e) => e.params.item.text ?? "")
    .join("\n");
const itemsOf = (result) =>
  result.events
    .filter((e) => e.method === "item/completed")
    .map((e) => e.params.item);
const safeId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_");
// Models sometimes format a marker's prefix and suffix separately in Markdown.
const hasMarker = (text, marker) =>
  text.replace(/[`*\s]/g, "").includes(marker);
const token = (prefix) => prefix + randomBytes(10).toString("hex");
const completed = (result) => {
  if (
    result.turn.error?.message?.startsWith(
      "Copilot Anthropic refused this request (",
    )
  )
    throw Object.assign(new Error(result.turn.error.message), {
      code: "PROVIDER_REFUSAL",
    });
  assert.equal(
    result.turn.status,
    "completed",
    JSON.stringify(result.turn.error),
  );
};

// Opt-in live regression: uses only generated test files/prompts, the installed
// native harness, the real bridge and official SDK. It never starts agents.
export async function checkModelSwitches({
  out,
  codexBin,
  copilotBin,
  jobs = 4,
  from,
  to,
  synthetic = false,
  simulateUsage = false,
}) {
  assert.ok(
    Number.isInteger(jobs) && jobs >= 1 && jobs <= 4,
    "jobs must be an integer from 1 to 4.",
  );
  await mkdir(out, { recursive: true, mode: 0o700 });
  const sourceSdk = await createSdkTransport({
    cliPath: copilotBin,
    directory: out,
  });
  let models;
  try {
    models = await listModels(async () => "sdk-owned", sourceSdk.transport, {
      messages: true,
      runtimeModelIds: sourceSdk.models.map((m) => m.id),
    });
  } finally {
    await sourceSdk.close();
  }
  await writeFile(join(out, "catalog.json"), JSON.stringify(models, null, 2), {
    mode: 0o600,
  });
  const sources = models.filter((m) => !from || from.includes(m.id));
  const destinations = models.filter((m) => !to || to.includes(m.id));
  const backend = synthetic
    ? switchFixture(models, { nearLimit: true })
    : fetch;
  assert.ok(
    sources.length && destinations.length,
    "The selected live models must be advertised by the seat.",
  );
  for (const id of [...(from ?? []), ...(to ?? [])])
    assert.ok(
      models.some((m) => m.id === id),
      `Not advertised: ${id}`,
    );
  const report = {
    started: new Date().toISOString(),
    models: models.map((m) => ({
      id: m.id,
      ...m.capabilities.limits,
      efforts: m.capabilities.supports.reasoning_effort ?? [],
    })),
    expected_pairs: sources.length * destinations.length,
    results: [],
  };
  const record = async (row) => {
    report.results.push(row);
    await appendFile(join(out, "results.jsonl"), JSON.stringify(row) + "\n", {
      mode: 0o600,
    });
    console.log(JSON.stringify(row));
  };
  let nextSource = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(jobs, sources.length) },
      async (_, workerId) => {
        const root = join(out, `worker-${workerId}`),
          state = join(root, "state"),
          project = join(root, "project");
        await mkdir(state, { recursive: true, mode: 0o700 });
        await mkdir(project, { mode: 0o700 });
        let seeding = false;
        const calls = [],
          wireModels = [];
        const sdk = await createSdkTransport({
          cliPath: copilotBin,
          directory: root,
          diagnosticFile: join(root, "diagnostics.jsonl"),
          forward: async (request) => {
            if (request.method === "POST")
              wireModels.push((await request.clone().json()).model);
            let response;
            try {
              response = await (request.method === "POST"
                ? backend(request)
                : fetch(request));
            } catch (error) {
              await appendFile(
                join(root, "backend-errors.private.jsonl"),
                JSON.stringify({ error: error.message, stack: error.stack }) +
                  "\n",
                { mode: 0o600 },
              );
              throw error;
            }
            if (request.method === "POST" && !response.ok) {
              const body = await response.clone().text();
              await appendFile(
                join(root, "upstream-errors.private.jsonl"),
                JSON.stringify({ status: response.status, body }) + "\n",
                { mode: 0o600 },
              );
            }
            return response;
          },
        });
        const localToken = randomBytes(24).toString("hex");
        const bridge = await startBridge({
          getToken: async () => "sdk-owned",
          localToken,
          models,
          model: models[0].id,
          transport: async (url, init) => {
            const p = JSON.parse(init.body);
            if (
              synthetic &&
              JSON.stringify(p.input).includes("CONTEXT CHECKPOINT COMPACTION")
            )
              await appendFile(
                join(root, "compaction-shapes.private.jsonl"),
                JSON.stringify({
                  model: p.model,
                  client_metadata: p.client_metadata,
                  tools: p.tools?.map((t) => ({ type: t.type, name: t.name })),
                  last_user: p.input.findLast((item) => item.role === "user"),
                }) + "\n",
                { mode: 0o600 },
              );
            calls.push({
              model: p.model,
              tools: p.tools?.length ?? 0,
              bytes: Buffer.byteLength(init.body),
              input: p.input,
            });
            const response = await sdk.transport(url, init);
            if (!simulateUsage || !seeding || !response.ok) return response;
            // Native control-flow fixture only. The SDK has already observed
            // the genuine stream and retains real token/billing accounting.
            // Only the isolated native test client's reported usage changes.
            return mapResponseEvents(response, (event) => {
              if (
                event.type !== "response.completed" ||
                !event.response?.output?.some(
                  (item) => item.type === "message",
                ) ||
                event.response.output.some((item) =>
                  ["function_call", "custom_tool_call"].includes(item.type),
                )
              )
                return event;
              const model = models.find((m) => m.id === p.model),
                usage = event.response.usage;
              const inputTokens =
                Math.floor(modelInputLimit(model) * 0.95) - 1200;
              return {
                ...event,
                response: {
                  ...event.response,
                  usage: {
                    ...usage,
                    input_tokens: inputTokens,
                    total_tokens: inputTokens + usage.output_tokens,
                  },
                },
              };
            });
          },
        });
        const invocation = codexInvocation({
          model: "gpt-6.1-sol",
          url: bridge.url,
          localToken,
          stateDir: state,
          args: [
            ...(await catalogArguments(
              models,
              models.find((m) => m.id === "gpt-6.1-sol") ?? models[0],
              "max",
              join(root, "models.json"),
            )),
            "--yolo",
            "app-server",
            "--listen",
            "stdio://",
          ],
        });
        const native = await nativeCheck({
          binary: codexBin,
          invocation,
          cwd: project,
          stderrFile: join(root, "native.stderr"),
        });
        try {
          const picker = await native.rpc("model/list", { limit: 100 });
          assert.deepEqual(
            new Set(picker.data.map((m) => m.model)),
            new Set(models.map((m) => m.id)),
          );
          while (nextSource < sources.length) {
            const source = sources[nextSource++],
              sourceId = safeId(source.id);
            const historyMarker = token("MATRIX_HISTORY_"),
              seed = join(project, `seed-${sourceId}.txt`),
              artifact = join(project, `artifact-${sourceId}.txt`);
            const patchMarker = `PATCH_AFTER_${sourceId}`;
            await writeFile(seed, historyMarker + "\n");
            await writeFile(artifact, "PATCH_BEFORE\n");
            let parent, sourceItems;
            try {
              parent = await native.rpc("thread/start", {
                cwd: project,
                model: source.id,
                approvalPolicy: "never",
                sandbox: "danger-full-access",
              });
              seeding = true;
              const result = await native.turn(
                parent.thread.id,
                source.id,
                `Regression test. Use shell to read ${seed}. Remember that exact MATRIX_HISTORY_ token for future turns. Use apply_patch to replace PATCH_BEFORE in ${artifact} with ${patchMarker}. Reply with the history token. Do not spawn agents.`,
                reasoningForModel(source),
              );
              seeding = false;
              completed(result);
              assert.ok(
                hasMarker(textOf(result), historyMarker),
                "Source forgot its marker.",
              );
              assert.ok(
                (await readFile(artifact, "utf8")).includes(patchMarker),
                "Native patch did not change the source artifact.",
              );
              assert.ok(
                itemsOf(result).some((item) => item.type === "fileChange"),
                "Source did not use native apply_patch.",
              );
              sourceItems = structuredClone(
                calls
                  .findLast((call) => call.model === source.id)
                  ?.input?.filter((item) =>
                    [
                      "function_call",
                      "custom_tool_call",
                      "function_call_output",
                      "custom_tool_call_output",
                    ].includes(item.type),
                  ) ?? [],
              );
              assert.ok(
                sourceItems.length >= 2,
                "Source did not save structured native tool history.",
              );
              await record({
                kind: "source",
                source: source.id,
                passed: true,
                patch: true,
                history: true,
                thread_id: parent.thread.id,
              });
            } catch (error) {
              seeding = false;
              await record({
                kind: "source",
                source: source.id,
                passed: false,
                error: error.message.slice(0, 1000),
                ...(error.code === "PROVIDER_REFUSAL"
                  ? { classification: "provider_refusal" }
                  : {}),
              });
              for (const target of destinations)
                await record({
                  kind: "pair",
                  source: source.id,
                  target: target.id,
                  passed: false,
                  stage: "source",
                });
              continue;
            }
            for (const target of destinations) {
              const start = Date.now(),
                offset = calls.length,
                wireOffset = wireModels.length;
              let branch;
              const proofMarker = token("MATRIX_TARGET_"),
                proof = join(
                  project,
                  `proof-${sourceId}-${safeId(target.id)}.txt`,
                );
              await writeFile(proof, proofMarker + "\n");
              try {
                branch = await native.rpc("thread/fork", {
                  threadId: parent.thread.id,
                  cwd: project,
                  approvalPolicy: "never",
                  sandbox: "danger-full-access",
                });
                const result = await native.turn(
                  branch.thread.id,
                  target.id,
                  `Continue this native session. Use shell to read ${proof} and ${artifact}. Reply with the exact MATRIX_HISTORY_ token you remember from the earlier turn, the MATRIX_TARGET_ token just read, and the PATCH_AFTER_ value from the artifact. Do not read any seed files. Do not spawn agents or change files.`,
                  reasoningForModel(target),
                );
                completed(result);
                const text = textOf(result),
                  items = itemsOf(result);
                if (text.trim() === "The model declined this request.")
                  throw Object.assign(
                    new Error(
                      "The provider declined this conversation; no refusal retry was attempted.",
                    ),
                    { code: "PROVIDER_REFUSAL" },
                  );
                assert.ok(
                  hasMarker(text, historyMarker),
                  "Target lost the source history marker.",
                );
                assert.ok(
                  hasMarker(text, proofMarker),
                  "Target did not read its new shell-tool result.",
                );
                assert.ok(
                  hasMarker(text, patchMarker),
                  "Target did not retain the patched filesystem state.",
                );
                assert.ok(
                  items.some((item) =>
                    ["commandExecution", "mcpToolCall"].includes(item.type),
                  ),
                  "Target completed without native shell tools.",
                );
                const first = calls
                  .slice(offset)
                  .find((call) => call.model === target.id);
                assert.ok(first, "No target inference observed.");
                assert.ok(
                  JSON.stringify(first.input).includes(historyMarker),
                  "Source history was missing from the native target request.",
                );
                const compacted = items.some(
                  (item) => item.type === "contextCompaction",
                );
                if (!compacted)
                  for (const saved of sourceItems) {
                    assert.deepEqual(
                      first.input.find(
                        (item) =>
                          item.type === saved.type &&
                          item.call_id === saved.call_id,
                      ),
                      saved,
                      "Native structured tool history changed during the model switch.",
                    );
                  }
                if (compacted && source.id !== target.id)
                  assert.equal(
                    wireModels[wireOffset],
                    source.id,
                    "Compaction must use the source model before switching.",
                  );
                const usage = result.events
                  .filter((e) => e.method === "thread/tokenUsage/updated")
                  .at(-1)?.params?.tokenUsage;
                await record({
                  kind: "pair",
                  source: source.id,
                  target: target.id,
                  passed: true,
                  history: true,
                  tools: true,
                  patched_files: true,
                  full_history: !compacted,
                  context_window: usage?.modelContextWindow ?? null,
                  request_count: calls.length - offset,
                  compacted,
                  ...(compacted
                    ? { compaction_model: wireModels[wireOffset] }
                    : {}),
                  ...(simulateUsage ? { native_usage_simulated: true } : {}),
                  elapsed_ms: Date.now() - start,
                });
              } catch (error) {
                await record({
                  kind: "pair",
                  source: source.id,
                  target: target.id,
                  passed: false,
                  error: error.message.slice(0, 1400),
                  ...(error.code === "PROVIDER_REFUSAL"
                    ? { classification: "provider_refusal" }
                    : {}),
                  elapsed_ms: Date.now() - start,
                });
              } finally {
                if (branch)
                  await native
                    .rpc("thread/unload", { threadId: branch.thread.id })
                    .catch(() => {});
                // History stays in the native test rollouts; only retain call metadata.
                for (const call of calls) delete call.input;
              }
            }
          }
        } finally {
          await native.close();
          await bridge.close();
          await sdk.close();
        }
      },
    ),
  );
  report.finished = new Date().toISOString();
  assert.equal(
    report.results.filter((r) => r.kind === "pair").length,
    report.expected_pairs,
    "Incomplete model matrix.",
  );
  report.passed_pairs = report.results.filter(
    (r) => r.kind === "pair" && r.passed,
  ).length;
  report.failed_pairs = report.results.filter(
    (r) => r.kind === "pair" && !r.passed,
  ).length;
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  return report;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "live": { type: "boolean" },
      "synthetic": { type: "boolean" },
      "near-limit": { type: "boolean" },
      "out": { type: "string" },
      "jobs": { type: "string", default: "4" },
      "from": { type: "string" },
      "to": { type: "string" },
    },
  });
  if (
    (!values.live && !values.synthetic) ||
    !values.out ||
    !process.env.COPILOT_PILOT_CODEX_BIN ||
    !process.env.COPILOT_PILOT_RUNTIME_BIN
  )
    throw new Error(
      "Set COPILOT_PILOT_CODEX_BIN and COPILOT_PILOT_RUNTIME_BIN, then pass --live --out PRIVATE_DIRECTORY [--jobs 4]. This performs real Copilot inference.",
    );
  const report = await checkModelSwitches({
    out: resolve(values.out),
    jobs: Number(values.jobs),
    from: values.from?.split(","),
    to: values.to?.split(","),
    codexBin: process.env.COPILOT_PILOT_CODEX_BIN,
    copilotBin: process.env.COPILOT_PILOT_RUNTIME_BIN,
    synthetic: values.synthetic,
    simulateUsage: values["near-limit"],
  });
  console.log(
    JSON.stringify({
      expected_pairs: report.expected_pairs,
      passed_pairs: report.passed_pairs,
      failed_pairs: report.failed_pairs,
    }),
  );
  process.exitCode = report.failed_pairs ? 1 : 0;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
