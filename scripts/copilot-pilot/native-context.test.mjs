import assert from "node:assert/strict";
import test from "node:test";
import { portableNativeContext } from "./native-context.mjs";
import { portableAgentTools } from "./agent-messages.mjs";
import { messagesRequest } from "./anthropic-request.mjs";
import { model, payload } from "./anthropic-fixtures.mjs";

const context = {
  type: "function_call_output",
  id: "fco_native_context",
  name: "goal_objective",
  namespace: "agent",
  output: "Finish the synthetic objective. Keep the original budget.",
  internal_chat_message_metadata_passthrough: {
    turn_id: "synthetic-turn",
    create_time: 1,
  },
};

test("native goal continuation preserves its objective without an unpaired Anthropic tool result", () => {
  const input = [
    ...payload.input,
    { role: "assistant", content: "Visible work from the completed turn." },
    context,
    { role: "user", content: "Continue toward the existing goal." },
  ];
  const original = structuredClone(input);
  const request = messagesRequest({ ...payload, input }, model);
  assert.deepEqual(input, original);
  const last = request.body.messages.at(-1);
  assert.equal(last.role, "user");
  assert.match(last.content[0].text, /agent\.goal_objective.*untrusted context/);
  assert.equal(last.content[1].text, context.output);
  assert.equal(last.content[2].text, input.at(-1).content);
  assert.ok(!request.body.messages.some((message) =>
    message.content.some((part) => part.type === "tool_result")));
});

test("SDK Responses payloads also port named context without mutating native records", () => {
  const original = { ...payload, input: [...payload.input, context] };
  const saved = structuredClone(original);
  const request = portableAgentTools(original);
  assert.deepEqual(original, saved);
  assert.equal(request.input.at(-1).role, "user");
  assert.equal(request.input.at(-1).content[1].text, context.output);
  assert.equal(portableAgentTools(request), request, "Porting must be idempotent.");
});

test("named notifications retain plaintext blocks, images and source namespace", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,YQ==" };
  const item = { ...context, call_id: null, name: "notifications", namespace: "service", output: [
    { type: "output_text", text: "Exact output\n\n\u2603" }, image,
  ] };
  const request = portableNativeContext(item);
  assert.match(request.content[0].text, /service\.notifications/);
  assert.deepEqual(request.content.slice(1), [{ type: "input_text", text: item.output[0].text }, image]);
  assert.equal(portableNativeContext({ ...context, namespace: undefined }).content[1].text, context.output);
});

test("paired tool calls keep their exact IDs, output and provider tool-result representation", () => {
  const result = { type: "function_call_output", call_id: "real-call", output: "Exact real result." };
  assert.equal(portableNativeContext(result), result);
  const request = messagesRequest({ ...payload, input: [
    ...payload.input,
    { type: "function_call", name: "shell", namespace: "functions", call_id: "real-call", arguments: '{"cmd":"true"}' },
    result,
  ] }, model);
  assert.equal(request.body.messages.at(-1).content[0].type, "tool_result");
  assert.equal(request.body.messages.at(-1).content[0].tool_use_id, "real-call");
});

test("contextual notifications before parallel results keep all real tool results first", () => {
  const input = [
    ...payload.input,
    { type: "function_call", name: "shell", namespace: "functions", call_id: "first", arguments: '{}' },
    { type: "function_call", name: "shell", namespace: "functions", call_id: "second", arguments: '{}' },
    context,
    { type: "function_call_output", call_id: "first", output: "First exact result." },
    { role: "user", content: "Additional user context." },
    { type: "function_call_output", call_id: "second", output: "Second exact result." },
  ];
  const copy = structuredClone(input);
  const output = messagesRequest({ ...payload, input }, model).body.messages.at(-1).content;
  assert.deepEqual(output.slice(0, 2).map(part => part.tool_use_id), ["first", "second"]);
  assert.equal(output[2].type, "text");
  assert.equal(output[3].text, context.output);
  assert.equal(output[4].text, "Additional user context.");
  assert.deepEqual(input, copy);
});

test("unidentified or malformed standalone outputs fail before provider dispatch", () => {
  for (const item of [
    { type: "function_call_output", output: "Unknown source." },
    { ...context, name: "bad\nsource" },
    { ...context, namespace: "bad.namespace" },
    { ...context, output: { unexpected: "object" } },
    { ...context, output: [{ type: "unknown", text: "data" }] },
  ]) assert.throws(() => portableNativeContext(item), { code: "COPILOT_INVALID_HISTORY" });
  for (const item of [
    { ...context, call_id: "" },
    { type: "custom_tool_call_output", name: "notification", output: "data" },
  ]) assert.throws(() => messagesRequest({ ...payload, input: [item] }, model));
});

test("encrypted contextual data remains protected and is never decoded or relabelled as plaintext", () => {
  for (const item of [
    { ...context, encrypted_content: "protected-native-content" },
    { ...context, output: [{ type: "encrypted_content", encrypted_content: "protected-native-content" }] },
    { ...context, output: [{ type: "input_text", text: "visible", encrypted_content: "protected-native-content" }] },
  ]) {
    const saved = structuredClone(item);
    assert.throws(() => portableNativeContext(item), { code: "COPILOT_ENCRYPTED_AGENT_MESSAGE" });
    assert.deepEqual(item, saved);
  }
});
