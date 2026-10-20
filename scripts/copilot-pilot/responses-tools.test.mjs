import assert from "node:assert/strict";
import test from "node:test";
import {
  functionToolsRequest,
  functionToolsResponse,
  responsesThinkingPrefix,
} from "./responses-tools.mjs";

const input = 'text(await tools.exec_command({cmd:"cat café.txt"}));';
const payload = {
  model: "grok-4.5",
  input: [
    {
      type: "custom_tool_call",
      id: "ctc_saved_item",
      call_id: "call",
      name: "exec",
      namespace: "functions",
      input,
    },
    {
      type: "custom_tool_call_output",
      id: "ctco_saved_item",
      call_id: "call",
      output: "saved output",
    },
  ],
  tools: [
    {
      type: "namespace",
      name: "functions",
      tools: [{ type: "custom", name: "exec", description: "Run JavaScript." }],
    },
  ],
};

test("Responses compatibility preserves raw custom input, call IDs and tool results in function schemas", () => {
  const request = functionToolsRequest(payload);
  assert.equal(request.body.tools[0].type, "function");
  assert.equal(request.body.tools[0].name, "functions__exec");
  assert.equal(JSON.parse(request.body.input[0].arguments).input, input);
  assert.equal(request.body.input[0].id, undefined);
  assert.equal(request.body.input[0].call_id, "call");
  assert.equal(request.body.input[1].type, "function_call_output");
  assert.equal(request.body.input[1].id, undefined);
  assert.equal(request.body.input[1].call_id, "call");
  assert.equal(request.body.input[1].output, "saved output");
});

test("non-GPT Responses translates plaintext agent history and marks collaboration calls as plaintext", async () => {
  const request = functionToolsRequest({
    ...payload,
    input: [
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/grok",
        content: [{ type: "input_text", text: "Read marker.txt" }],
      },
    ],
    tools: [
      {
        type: "namespace",
        name: "collaboration",
        tools: [
          {
            type: "function",
            name: "send_message",
            parameters: { type: "object" },
          },
        ],
      },
    ],
  });
  assert.equal(request.body.input[0].type, "message");
  assert.equal(request.body.input[0].content[1].text, "Read marker.txt");
  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc_message",
      name: "collaboration__send_message",
      call_id: "message-call",
      arguments: '{"target":"child","message":"Task result"}',
    },
  };
  const body = await functionToolsResponse(
    new Response(`data: ${JSON.stringify(event)}\n\n`),
    request,
  ).text();
  const call = JSON.parse(body.slice(6)).item;
  assert.equal(call.namespace, "collaboration");
  assert.deepEqual(call.encrypted_function_args, []);
  assert.equal(call.call_id, "message-call");
});

test("Responses compatibility emits only complete validated custom calls and preserves terminal accounting", async () => {
  const request = functionToolsRequest(payload);
  const call = {
    type: "function_call",
    id: "fc",
    call_id: "call",
    name: "functions__exec",
    arguments: JSON.stringify({ input }),
  };
  const values = [
    { type: "response.output_item.added", item: { ...call, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc",
      delta: '{"input":"partial',
    },
    { type: "response.output_item.done", item: call },
    {
      type: "response.completed",
      response: {
        id: "done",
        usage: { input_tokens: 21, output_tokens: 12 },
        output: [call],
      },
      copilot_usage: { total_nano_aiu: 7 },
    },
  ];
  const bytes = Buffer.from(
    values
      .map((v) => `event: ${v.type}\ndata: ${JSON.stringify(v)}\n\n`)
      .join(""),
  );
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7)
        controller.enqueue(bytes.subarray(i, i + 7));
      controller.close();
    },
  });
  const result = await functionToolsResponse(
    new Response(body),
    request,
  ).text();
  const events = result
    .split("\n")
    .filter((v) => v.startsWith("data:"))
    .map((v) => JSON.parse(v.slice(5)));
  assert.equal(events[1].type, "response.in_progress");
  assert.equal(events[2].item.type, "custom_tool_call");
  assert.equal(events[2].item.input, input);
  assert.equal(events[2].item.namespace, "functions");
  assert.equal(events.at(-1).response.output[0].input, input);
  assert.deepEqual(events.at(-1).copilot_usage, { total_nano_aiu: 7 });
});

test("Responses compatibility rejects undeclared output tools and malformed custom input", async () => {
  const request = functionToolsRequest(payload);
  for (const call of [
    { type: "function_call", name: "undeclared", arguments: "{}" },
    {
      type: "function_call",
      name: "functions__exec",
      arguments: '{"input":123}',
    },
  ]) {
    const response = new Response(
      `data: ${JSON.stringify({ type: "response.output_item.done", item: call })}\n\n`,
    );
    await assert.rejects(functionToolsResponse(response, request).text());
  }
});

test("non-GPT opaque reasoning retains provider provenance in saved history", async () => {
  const event = {
    type: "response.output_item.done",
    item: { type: "reasoning", encrypted_content: "opaque-provider-state" },
  };
  const adapted = await functionToolsResponse(
    new Response(`data: ${JSON.stringify(event)}\n\n`),
    functionToolsRequest(payload),
  ).text();
  assert.equal(
    JSON.parse(adapted.slice(6)).item.encrypted_content,
    responsesThinkingPrefix + "opaque-provider-state",
  );
});
