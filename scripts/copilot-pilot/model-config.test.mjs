import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { model } from "./anthropic-fixtures.mjs";
import { modelArguments } from "./model-config.mjs";

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
    "model_auto_compact_token_limit=828400",
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
          auto_compact_token_limit: 875900,
        },
      ],
    },
  );
});
