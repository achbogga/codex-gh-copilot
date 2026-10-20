import assert from "node:assert/strict";
import test from "node:test";
import { sameInferenceModel } from "./inference-model.mjs";

test("wire model proof accepts documented aliases while rejecting fallbacks and unknown snapshots", () => {
  assert.ok(sameInferenceModel("claude-opus-4.8", "claude-opus-4-8"));
  assert.ok(
    sameInferenceModel("claude-haiku-4.5", "claude-haiku-4-5-20251001"),
  );
  assert.ok(sameInferenceModel("gpt-6.1-sol", "gpt-6.1-sol"));
  for (const [requested, served] of [
    ["claude-opus-5", "claude-opus-4-8"],
    ["claude-opus-5.5", "claude-opus-5"],
    ["claude-haiku-4.5", "claude-haiku-4-5-20990101"],
    ["gpt-6.1-sol", "gpt-6-sol"],
    ["gpt-6.1-sol", "gpt-6-1-sol"],
    ["claude-opus-5", undefined],
    [undefined, undefined],
  ])
    assert.equal(sameInferenceModel(requested, served), false);
});
