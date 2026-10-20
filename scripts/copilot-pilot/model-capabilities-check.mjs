import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSdkTransport } from "./sdk-transport.mjs";
import { listModels } from "./bridge.mjs";
import { reasoningForModel } from "./model-config.mjs";

// Explicitly opt-in: these are real, billable seat requests. Context mode sends
// generated padding near the advertised input limit, never repository content.
const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    out: { type: "string" },
    reasoning: { type: "boolean" },
    context: { type: "boolean" },
    models: { type: "string" },
    efforts: { type: "string" },
  },
});
assert.ok(
  values.live &&
    values.out &&
    (values.reasoning || values.context) &&
    process.env.COPILOT_PILOT_RUNTIME_BIN,
  "Set COPILOT_PILOT_RUNTIME_BIN and pass --live --out PRIVATE_DIRECTORY --reasoning and/or --context.",
);
const out = resolve(values.out);
await mkdir(out, { recursive: true, mode: 0o700 });
const sdk = await createSdkTransport({
  cliPath: process.env.COPILOT_PILOT_RUNTIME_BIN,
  directory: out,
  diagnosticFile: join(out, "diagnostics.jsonl"),
});
const results = [];
const hasMarker = (text, marker) =>
  text.replace(/[`*\s]/g, "").includes(marker);
const record = async (row) => {
  results.push(row);
  await appendFile(join(out, "results.jsonl"), JSON.stringify(row) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(row));
};
const infer = async (model, effort, prompt) => {
  const response = await sdk.transport("http://localhost/responses", {
    body: JSON.stringify({
      model: model.id,
      stream: true,
      store: false,
      input: [{ role: "user", content: prompt }],
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: 32768,
      tools: [],
      include: ["reasoning.encrypted_content"],
    }),
    signal: AbortSignal.timeout(300000),
    headers: { "X-Initiator": "user" },
  });
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}: ${(await response.text()).slice(0, 1200)}`,
    );
  const text = await response.text();
  const events = text
    .split("\n")
    .filter((l) => l.startsWith("data:") && l.slice(5).trim().startsWith("{"))
    .map((l) => JSON.parse(l.slice(5)));
  const terminal = events.findLast((e) =>
    [
      "response.completed",
      "response.failed",
      "response.incomplete",
      "error",
    ].includes(e.type),
  );
  assert.equal(
    terminal?.type,
    "response.completed",
    JSON.stringify(
      terminal?.response?.error ?? terminal?.error ?? { type: terminal?.type },
    ),
  );
  const output =
    terminal.response.output ??
    events
      .filter((e) => e.type === "response.output_item.done")
      .map((e) => e.item);
  return {
    text: output
      .filter((i) => i.type === "message")
      .flatMap((i) => i.content ?? [])
      .map((i) => i.text ?? "")
      .join("\n"),
    usage: terminal.response.usage,
  };
};
try {
  const catalog = await listModels(async () => "sdk-owned", sdk.transport, {
    messages: true,
    runtimeModelIds: sdk.models.map((m) => m.id),
  });
  const models = catalog.filter(
    (m) => !values.models || values.models.split(",").includes(m.id),
  );
  assert.ok(models.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, models.length) }, async () => {
      while (next < models.length) {
        const model = models[next++];
        if (values.reasoning)
          for (const effort of (model.capabilities.supports.reasoning_effort
            ?.length
            ? model.capabilities.supports.reasoning_effort
            : [undefined]
          ).filter(
            (effort) =>
              !values.efforts ||
              values.efforts.split(",").includes(effort ?? "thinking-budget"),
          )) {
            const marker = "EFFORT_OK_" + randomBytes(8).toString("hex"),
              start = Date.now();
            try {
              const result = await infer(
                model,
                effort,
                `A harmless API compatibility check. Reply with exactly ${marker}.`,
              );
              assert.ok(
                result.usage?.input_tokens > 0,
                "Missing real provider accounting.",
              );
              await record({
                kind: "reasoning",
                model: model.id,
                effort: effort ?? "thinking-budget",
                passed: true,
                marker_returned: hasMarker(result.text, marker),
                ...(!hasMarker(result.text, marker)
                  ? { visible_answer: result.text.slice(0, 1000) }
                  : {}),
                usage: result.usage,
                elapsed_ms: Date.now() - start,
              });
            } catch (error) {
              await record({
                kind: "reasoning",
                model: model.id,
                effort: effort ?? "thinking-budget",
                passed: false,
                error: error.message,
                elapsed_ms: Date.now() - start,
              });
            }
          }
        if (values.context) {
          const start = Date.now();
          try {
            const first = "CAPACITY_BEGIN_" + randomBytes(8).toString("hex"),
              last = "CAPACITY_END_" + randomBytes(8).toString("hex");
            const row = (i) =>
              `Record ${String(i).padStart(7, "0")}: sandstone, maple, blue lantern, river, paper, quiet garden.\n`;
            const padding = (n) =>
              Array.from({ length: n }, (_, i) => row(i)).join("");
            const prompt = (n) =>
              `Return exactly the two CAPACITY markers at the beginning and end of the following benign generated data. Do not summarize the records.\n${first}\n${padding(n)}${last}\nReturn those two markers now.`;
            const effort = reasoningForModel(model),
              low = reasoningForModel(model, "low");
            const calibration = await infer(model, low, prompt(512));
            const baseline = await infer(model, low, prompt(0));
            assert.ok(
              calibration.usage?.input_tokens > 0,
              "Missing real provider token count.",
            );
            const limits = model.capabilities.limits;
            const limit = Math.min(
              limits.max_prompt_tokens,
              limits.max_context_window_tokens - limits.max_output_tokens,
            );
            const lines = Math.floor(
              ((limit * 0.94 - baseline.usage.input_tokens) /
                (calibration.usage.input_tokens -
                  baseline.usage.input_tokens)) *
                512,
            );
            const large = prompt(lines);
            const result = await infer(model, effort, large);
            assert.ok(
              result.usage?.input_tokens >= limit * 0.87,
              `The real input ${result.usage?.input_tokens} did not reach 87% of the advertised input limit ${limit}.`,
            );
            await record({
              kind: "context",
              model: model.id,
              passed: true,
              retrieval_passed:
                hasMarker(result.text, first) && hasMarker(result.text, last),
              ...(!(
                hasMarker(result.text, first) && hasMarker(result.text, last)
              )
                ? { visible_answer: result.text.slice(0, 1000) }
                : {}),
              advertised_context: limits.max_context_window_tokens,
              advertised_input_limit: limit,
              input_tokens: result.usage.input_tokens,
              input_fraction: result.usage.input_tokens / limit,
              request_text_bytes: Buffer.byteLength(large),
              effort: effort ?? "thinking-budget",
              elapsed_ms: Date.now() - start,
            });
          } catch (error) {
            await record({
              kind: "context",
              model: model.id,
              passed: false,
              error: error.message,
              elapsed_ms: Date.now() - start,
            });
          }
        }
      }
    }),
  );
} finally {
  await sdk.close();
  await writeFile(
    join(out, "report.json"),
    JSON.stringify(
      {
        finished: new Date().toISOString(),
        results,
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed).length,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
process.exitCode = results.some((r) => !r.passed) ? 1 : 0;
