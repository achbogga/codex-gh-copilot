import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { model } from "./anthropic-fixtures.mjs";
import {
  modelArguments,
  catalogArguments,
  reasoningForModel,
  modelCompactLimit,
} from "./model-config.mjs";

test("switchable catalogs keep context and reasoning limits per model without global overrides", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "copilot-switchable-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const small = {
    ...model,
    id: "small-responses-model",
    supported_endpoints: ["/responses"],
    capabilities: {
      supports: {
        tool_calls: true,
        streaming: true,
        reasoning_effort: ["low", "high"],
      },
      limits: {
        max_context_window_tokens: 200000,
        max_prompt_tokens: 136000,
        max_output_tokens: 64000,
      },
    },
  };
  const args = await catalogArguments(
    [model, small],
    model,
    "max",
    join(dir, "catalog.json"),
  );
  assert.ok(
    !args.some(
      (arg) =>
        arg.startsWith("model_context_window=") ||
        arg.startsWith("model_auto_compact_token_limit="),
    ),
  );
  const entries = JSON.parse(
    await readFile(join(dir, "catalog.json"), "utf8"),
  ).models;
  assert.equal(entries[0].context_window, 1000000);
  assert.equal(entries[1].context_window, 200000);
  assert.equal(entries[0].auto_compact_token_limit, 572400);
  assert.equal(entries[1].auto_compact_token_limit, 68000);
  assert.equal(entries[1].default_reasoning_level, "high");
  assert.equal(entries[0].priority, 0);
  assert.equal(reasoningForModel(small, "max"), "high");
  assert.equal(reasoningForModel(small, "xhigh"), "high");
  assert.equal(reasoningForModel(small, "none"), "high");
  assert.throws(() => reasoningForModel(small, "adaptive"), /Unsupported/);
  assert.equal(entries[0].comp_hash, entries[1].comp_hash);
  assert.equal(entries[0].tool_mode, "code_mode");
  assert.equal(entries[1].tool_mode, "code_mode");
});

test("context configuration reserves output space and uses the container catalog path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "opus-catalog-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const args = await modelArguments(
    model,
    "max",
    join(dir, "catalog.json"),
    "/container/catalog.json",
  );
  assert.deepEqual(args, [
    "-c",
    'model_reasoning_effort="max"',
    "-c",
    "model_context_window=1000000",
    "-c",
    "model_auto_compact_token_limit=572400",
    "-c",
    'model_auto_compact_token_limit_scope="total"',
    "-c",
    'model_catalog_json="/container/catalog.json"',
  ]);
  const catalog = JSON.parse(await readFile(join(dir, "catalog.json"), "utf8"));
  assert.equal(
    catalog.models[0].max_context_window,
    model.capabilities.limits.max_context_window_tokens,
  );
});

test("provider limits override bundled GPT context caps while retaining native model behavior", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "copilot-gpt-catalog-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundled = JSON.parse(
    await readFile(
      new URL("../../codex-rs/models-manager/models.json", import.meta.url),
      "utf8",
    ),
  );
  const original = bundled.models.find((entry) => entry.slug === "gpt-6.1-sol");
  const selected = {
    ...model,
    id: original.slug,
    supported_endpoints: ["/responses"],
    capabilities: {
      ...model.capabilities,
      limits: {
        max_context_window_tokens: 1050000,
        max_prompt_tokens: 922000,
        max_output_tokens: 128000,
      },
    },
  };
  await modelArguments(selected, "max", join(dir, "catalog.json"));
  assert.deepEqual(
    JSON.parse(await readFile(join(dir, "catalog.json"), "utf8")),
    {
      models: [
        {
          ...original,
          context_window: 1050000,
          max_context_window: 1050000,
          auto_compact_token_limit: 619900,
        },
      ],
    },
  );
});

test("compaction reserves two maximum outputs when possible and handles absent output limits", () => {
  const limits = { max_context_window_tokens: 1050000, max_prompt_tokens: 922000, max_output_tokens: 128000 };
  const compact = modelCompactLimit({ capabilities: { limits } });
  assert.ok(compact + 2 * limits.max_output_tokens < limits.max_prompt_tokens);
  assert.equal(modelCompactLimit({ capabilities: { limits: { max_prompt_tokens: 100000 } } }), 95000);
  assert.equal(modelCompactLimit({ capabilities: { limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 } } }), 68000);
});
