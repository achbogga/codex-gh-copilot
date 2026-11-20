import assert from "node:assert/strict";
import test from "node:test";
import { expandedNativeTools } from "./native-tools.mjs";
import { messagesRequest } from "./anthropic-request.mjs";
import { functionToolsRequest } from "./responses-tools.mjs";
import { model } from "./anthropic-fixtures.mjs";

const exec = { type: "custom", name: "exec", description: "Run native code" };
const notify = { type: "function", name: "notify", parameters: { type: "object", properties: {} } };
const declarations = tools => ({ type: "additional_tools", id: "native-declaration", role: "developer",
  tools: [{ type: "namespace", name: "functions", tools }] });
const history = () => ({ model: "claude-opus-5.5", stream: true, tools: [], input: [
  declarations([exec]), { role: "user", content: "Read the fixture." },
  { type: "custom_tool_call", name: "exec", call_id: "same-call", input: 'text("fixture")' },
  { type: "custom_tool_call_output", call_id: "same-call", output: "fixture-result" },
  declarations([notify]), { role: "user", content: "Continue on the new model." },
] });

test("incremental native declarations become active destination tools while preserving history and original records", () => {
  const original = history(), saved = structuredClone(original);
  const expanded = expandedNativeTools(original);
  assert.deepEqual(expanded.tools[0].tools, [exec, notify]);
  assert.equal(expanded.input.length, 4);
  for (const item of expanded.input) assert.ok(saved.input.some(v => JSON.stringify(v) === JSON.stringify(item)));
  assert.deepEqual(original, saved);
  for (const request of [messagesRequest(original, model), functionToolsRequest({ ...original, model: "grok-4.7" })]) {
    assert.deepEqual(request.body.tools.map(t => t.name), ["functions__exec", "functions__notify"]);
    const items = request.body.messages?.flatMap(m => m.content) ?? request.body.input;
    const call = items.find(v => ["tool_use", "function_call"].includes(v.type));
    const result = items.find(v => ["tool_result", "function_call_output"].includes(v.type));
    assert.equal(call.name, "functions__exec");
    assert.equal(call.id ?? call.call_id, "same-call");
    assert.equal(result.tool_use_id ?? result.call_id, "same-call");
    assert.equal(JSON.stringify(request.body).includes('"additional_tools"'), false);
  }
});

test("identical declarations deduplicate, conflicting schemas fail, and explicit namespace wins over its alias", () => {
  const p = history(); p.tools = [declarations([exec]).tools[0]];
  assert.equal(expandedNativeTools(p).tools[0].tools.length, 2);
  p.input.push(declarations([{ ...exec, description: "changed definition" }]));
  assert.throws(() => expandedNativeTools(p), /Conflicting/);
  const aliases = history(); aliases.tools = [exec];
  for (const namespace of [undefined, "functions"]) {
    aliases.input[2] = { ...aliases.input[2], namespace };
    const name = namespace ? "functions__exec" : "exec";
    assert.equal(messagesRequest(aliases, model).body.messages.flatMap(v => v.content)
      .find(v => v.type === "tool_use").name, name);
    assert.equal(functionToolsRequest(aliases).body.input.find(v => v.type === "function_call").name, name);
  }
});

test("encrypted or unknown declaration content is never discarded as tool metadata", () => {
  for (const extra of [{ encrypted_content: "protected" }, { content: [{ type: "encrypted_content", data: "protected" }] },
    { unrelated_instructions: "keep protected" }]) {
    const p = history(); Object.assign(p.input[0], extra); const saved = structuredClone(p);
    assert.throws(() => expandedNativeTools(p)); assert.deepEqual(p, saved);
  }
});
