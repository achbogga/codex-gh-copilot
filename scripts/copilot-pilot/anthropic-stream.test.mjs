import assert from "node:assert/strict";
import test from "node:test";
import { model, payload } from "./anthropic-fixtures.mjs";
import { messagesRequest } from "./anthropic-request.mjs";
import { messagesResponse } from "./anthropic-stream.mjs";

const thinking = {
  type: "thinking",
  thinking: "",
  signature: "signed-opaque-data",
};
const blocks = [
  thinking,
  {
    type: "tool_use",
    id: "call-1",
    name: "functions__shell",
    input: { cmd: "pwd" },
  },
  {
    type: "tool_use",
    id: "call-2",
    name: "functions__apply_patch",
    input: { input: "*** Begin Patch\n*** End Patch" },
  },
];
const events = (content = blocks, stop = "tool_use") => [
  {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: model.id,
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 3,
        output_tokens: 1,
      },
    },
  },
  ...content.flatMap((block, index) => [
    {
      type: "content_block_start",
      index,
      content_block:
        block.type === "tool_use"
          ? { ...block, input: {} }
          : block.type === "thinking"
            ? { ...block, signature: "" }
            : { ...block, text: "" },
    },
    {
      type: "content_block_delta",
      index,
      delta:
        block.type === "tool_use"
          ? {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            }
          : block.type === "thinking"
            ? { type: "signature_delta", signature: block.signature }
            : { type: "text_delta", text: block.text },
    },
    { type: "content_block_stop", index },
  ]),
  {
    type: "message_delta",
    delta: { stop_reason: stop },
    usage: { output_tokens: 7 },
    copilot_usage: { total_nano_aiu: 123 },
  },
  { type: "message_stop" },
];
function response(values) {
  const bytes = Buffer.from(
    values
      .map(
        (value) =>
          `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`,
      )
      .join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.subarray(i, i + 7));
        controller.close();
      },
    }),
  );
}

test("Messages stream replays signed thinking, namespaced tools and parallel results without an SDK tool loop", async () => {
  const translated = messagesResponse(
    response(events()),
    messagesRequest(payload, model),
  );
  const output = (await translated.response.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(6)));
  const completed = output.at(-1).response;
  assert.deepEqual(completed.usage, {
    input_tokens: 18,
    output_tokens: 7,
    total_tokens: 25,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 3 },
  });
  assert.deepEqual(completed.output.slice(1), [
    {
      id: "msg_test_1",
      type: "function_call",
      call_id: "call-1",
      name: "shell",
      namespace: "functions",
      arguments: '{"cmd":"pwd"}',
    },
    {
      id: "msg_test_2",
      type: "custom_tool_call",
      call_id: "call-2",
      name: "apply_patch",
      namespace: "functions",
      input: "*** Begin Patch\n*** End Patch",
    },
  ]);
  const replay = messagesRequest(
    {
      ...payload,
      input: [
        ...payload.input,
        ...completed.output,
        { type: "function_call_output", call_id: "call-1", output: "cwd" },
        {
          type: "custom_tool_call_output",
          call_id: "call-2",
          output: "patched",
        },
      ],
    },
    model,
  );
  assert.deepEqual(replay.body.messages, [
    { role: "user", content: [{ type: "text", text: "Fix the file." }] },
    { role: "assistant", content: blocks },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [{ type: "text", text: "cwd" }],
        },
        {
          type: "tool_result",
          tool_use_id: "call-2",
          content: [{ type: "text", text: "patched" }],
        },
      ],
    },
  ]);
  assert.deepEqual(await translated.completion, {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: model.id,
    usage: {
      input_tokens: 5,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 3,
      output_tokens: 7,
    },
    stop_reason: "end_turn",
    copilot_usage: { total_nano_aiu: 123 },
    content: [{ type: "text", text: "Forwarded to Codex." }],
  });
});

test("stream handles fragmented UTF-8 text and refuses truncated, errored or output-limited responses", async () => {
  const text = "Fixed café ✅";
  const translated = messagesResponse(
    response(events([{ type: "text", text }], "end_turn")),
    messagesRequest(payload, model),
  );
  assert.match(await translated.response.text(), /Fixed café ✅/);
  assert.ok(await translated.completion);
  for (const values of [
    events().slice(0, -1),
    events(blocks, "max_tokens"),
    [{ type: "error", error: { message: "private upstream data" } }],
  ]) {
    const failed = messagesResponse(
      response(values),
      messagesRequest(payload, model),
    );
    await assert.rejects(failed.response.text(), /Anthropic/);
    assert.equal(await failed.completion, null);
  }
});
