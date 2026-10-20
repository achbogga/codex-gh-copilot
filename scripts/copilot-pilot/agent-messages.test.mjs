import assert from "node:assert/strict";
import test from "node:test";
import { messagesRequest } from "./anthropic-request.mjs";
import { model, payload } from "./anthropic-fixtures.mjs";
import { startBridge } from "./bridge.mjs";
import {
  portableAgentMessage,
  portableAgentTools,
  portableAgentResponse,
  plaintextAgentCall,
  agentWireNamespace,
} from "./agent-messages.mjs";

const message = {
  type: "agent_message",
  author: "/root",
  recipient: "/root/opus",
  content: [
    { type: "input_text", text: "Read marker.txt. Do not change files." },
  ],
};
const call = {
  type: "function_call",
  id: "fc_task",
  call_id: "task-call",
  namespace: "collaboration",
  name: "spawn_agent",
  arguments: '{"message":"Read marker.txt","model":"claude-opus-5.5"}',
};
const definition = {
  type: "namespace",
  name: "collaboration",
  tools: [
    {
      type: "function",
      name: "spawn_agent",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Task instructions",
            encrypted: true,
          },
          model: { type: "string" },
        },
      },
    },
  ],
};

test("Claude receives the complete plaintext agent task with sender and recipient", () => {
  const translated = messagesRequest({ ...payload, input: [message] }, model);
  assert.equal(translated.body.messages[0].role, "user");
  assert.match(translated.body.messages[0].content[0].text, /\/root\/opus/);
  assert.equal(
    translated.body.messages[0].content[1].text,
    message.content[0].text,
  );
});

test("portable collaboration schemas request plaintext without altering other tools or the original", () => {
  const unrelated = { ...definition, name: "unrelated" };
  const request = { tools: [definition, unrelated], input: "Start a task" };
  const converted = portableAgentTools(request);
  assert.equal(converted.tools[0].name, agentWireNamespace);
  assert.equal(
    converted.tools[0].tools[0].parameters.properties.message.encrypted,
    undefined,
  );
  assert.equal(
    definition.tools[0].parameters.properties.message.encrypted,
    true,
  );
  assert.equal(converted.tools[1].tools[0], unrelated.tools[0]);
  assert.equal(converted.input, request.input);
  assert.equal(
    portableAgentTools({ input: "No agent tools" }).input,
    "No agent tools",
  );
});

test("plaintext calls select the native plaintext delivery path without changing instructions or call IDs", () => {
  const converted = plaintextAgentCall(call);
  assert.deepEqual(converted.encrypted_function_args, []);
  assert.equal(converted.arguments, call.arguments);
  assert.equal(converted.call_id, call.call_id);
  assert.deepEqual(
    plaintextAgentCall({ ...call, namespace: agentWireNamespace }),
    converted,
  );
  const unrelated = { ...call, namespace: "functions" };
  assert.equal(plaintextAgentCall(unrelated), unrelated);
  assert.throws(
    () => plaintextAgentCall({ ...call, encrypted_function_args: ["message"] }),
    { code: "COPILOT_ENCRYPTED_AGENT_MESSAGE" },
  );
});

test("GPT streams retain ordinary bytes while portable task calls and accounting survive fragmented UTF-8", async () => {
  const ordinary =
    'event: response.in_progress\r\ndata: {"type":"response.in_progress","text":"café"}\r\n\r\n';
  const terminal = {
    type: "response.completed",
    response: {
      output: [{ ...call, namespace: agentWireNamespace }],
      usage: { input_tokens: 100, output_tokens: 12 },
    },
    copilot_usage: { total_nano_aiu: 9 },
  };
  const bytes = Buffer.from(ordinary + `data: ${JSON.stringify(terminal)}\n\n`);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 3)
        controller.enqueue(bytes.subarray(i, i + 3));
      controller.close();
    },
  });
  const mapped = await portableAgentResponse(new Response(body)).text();
  assert.ok(mapped.startsWith(ordinary));
  const completed = JSON.parse(mapped.slice(ordinary.length + 6));
  assert.deepEqual(completed.response.output[0], {
    ...call,
    encrypted_function_args: [],
  });
  assert.deepEqual(completed.response.usage, terminal.response.usage);
  assert.deepEqual(completed.copilot_usage, terminal.copilot_usage);
});

test("encrypted agent instructions fail once with an actionable error before upstream inference", async (t) => {
  const encrypted = {
    ...message,
    content: [
      ...message.content,
      {
        type: "encrypted_content",
        encrypted_content: "PRIVATE_ENCRYPTED_TASK",
      },
    ],
  };
  assert.throws(() => portableAgentMessage(encrypted), {
    code: "COPILOT_ENCRYPTED_AGENT_MESSAGE",
  });
  let requests = 0;
  const bridge = await startBridge({
    model: model.id,
    getToken: async () => "synthetic",
    localToken: "local",
    transport: async (_url, init) => {
      requests++;
      messagesRequest(JSON.parse(init.body), model);
      throw new Error("Must not reach upstream.");
    },
  });
  t.after(() => bridge.close());
  const response = await fetch(bridge.url + "/responses", {
    method: "POST",
    headers: {
      "authorization": "Bearer local",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...payload, stream: true, input: [encrypted] }),
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(requests, 1);
  assert.match(body, /invalid_prompt/);
  assert.match(body, /OpenAI-encrypted agent message/);
  assert.doesNotMatch(body, /PRIVATE_ENCRYPTED_TASK/);
  assert.doesNotMatch(body, /response.completed/);
});

test("unexpected encrypted task calls stop the stream without executing or retrying them", async (t) => {
  const bridge = await startBridge({
    model: model.id,
    getToken: async () => "synthetic",
    localToken: "local",
    transport: async () =>
      portableAgentResponse(
        new Response(
          `data: ${JSON.stringify({ type: "response.output_item.done", item: { ...call, namespace: agentWireNamespace, encrypted_function_args: ["message"] } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
  });
  t.after(() => bridge.close());
  const response = await fetch(bridge.url + "/responses", {
    method: "POST",
    headers: {
      "authorization": "Bearer local",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...payload, stream: true }),
  });
  const text = await response.text();
  assert.match(text, /invalid_prompt/);
  assert.match(text, /OpenAI-encrypted agent message/);
  assert.doesNotMatch(text, /response.completed|task-call|Read marker.txt/);
});
