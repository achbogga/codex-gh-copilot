import assert from "node:assert/strict";
import test from "node:test";
import { model, payload } from "./anthropic-fixtures.mjs";
import { messagesRequest, thinkingPrefix } from "./anthropic-request.mjs";
import { listModels } from "./bridge.mjs";

test("unsupported history, tools and tool-name collisions fail closed", () => {
  for (const change of [
    { input: [{ type: "compaction", encrypted_content: "opaque" }] },
    { tools: [{ type: "web_search" }] },
    {
      tools: [
        ...payload.tools,
        { type: "function", name: "functions__shell", parameters: {} },
      ],
    },
    { tool_choice: "required" },
  ])
    assert.throws(() => messagesRequest({ ...payload, ...change }, model));
});

test("model switches retain visible history while omitting foreign opaque reasoning", () => {
  const request = messagesRequest(
    {
      ...payload,
      input: [
        ...payload.input,
        { type: "reasoning", encrypted_content: "foreign" },
        { role: "assistant", content: "Saved visible progress." },
        { role: "user", content: "Continue on Claude." },
      ],
    },
    model,
  );
  assert.equal(
    request.body.messages[1].content[0].text,
    "Saved visible progress.",
  );
  assert.equal(request.body.messages[2].content[0].text, "Continue on Claude.");
});

test("native assistant continuations retain complete history without unsupported prefill", () => {
  const input = [
    ...payload.input,
    { role: "assistant", content: "Visible work from the previous model." },
  ];
  const translated = messagesRequest({ ...payload, input }, model);
  assert.equal(
    translated.body.messages.at(-2).content[0].text,
    input.at(-1).content,
  );
  assert.equal(translated.body.messages.at(-1).role, "user");
  assert.match(
    translated.body.messages.at(-1).content[0].text,
    /Continue the pending task/,
  );
  assert.equal(input.length, payload.input.length + 1);
});

test("Code Mode models receive output-printing instructions alongside native tool definitions", () => {
  const request = messagesRequest(
    {
      ...payload,
      tools: [{ type: "custom", name: "exec", description: "Run JavaScript" }],
    },
    model,
  );
  assert.match(
    request.body.system.at(-1).text,
    /text\(await tools.exec_command/,
  );
  assert.equal(request.body.tools[0].name, "exec");
});

test("separate signed thinking responses retain provider boundaries across native history and restart", () => {
  for (const legacy of [false, true]) {
    const reasoning = (id, signature) => ({
      id: `${id}_0`,
      type: "reasoning",
      encrypted_content:
        thinkingPrefix +
        Buffer.from(
          JSON.stringify({
            model: model.id,
            ...(legacy ? {} : { message_id: id }),
            block: { type: "thinking", thinking: "", signature },
          }),
        ).toString("base64"),
    });
    const input = [
      ...payload.input,
      reasoning("msg_first", "first-signed-block"),
      reasoning("msg_second", "second-signed-block"),
      {
        type: "function_call",
        id: "msg_second_1",
        call_id: "call_native",
        namespace: "functions",
        name: "shell",
        arguments: '{"cmd":"pwd"}',
      },
      {
        type: "function_call_output",
        call_id: "call_native",
        output: "workspace",
      },
    ];
    const request = messagesRequest(
      { ...payload, input: JSON.parse(JSON.stringify(input)) },
      model,
    );
    assert.deepEqual(
      request.body.messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant", "user"],
    );
    assert.equal(
      request.body.messages[1].content[0].signature,
      "first-signed-block",
    );
    assert.equal(
      request.body.messages[3].content[0].signature,
      "second-signed-block",
    );
    assert.equal(request.body.messages[3].content[1].tool_use_id, undefined);
    assert.equal(request.body.messages[3].content[1].id, "call_native");
    assert.equal(
      request.body.messages[4].content[0].tool_use_id,
      "call_native",
    );
  }
});

test("Messages discovery requires SDK opt-in and enabled policy", async () => {
  const transport = async () =>
    Response.json({
      data: [model, { ...model, policy: { state: "disabled" } }],
    });
  assert.deepEqual(await listModels(async () => "fake", transport), []);
  assert.deepEqual(
    await listModels(async () => "fake", transport, { messages: true }),
    [model],
  );
});

test("discovery accepts runtime-authorized policy defaults and still excludes explicit denials", async () => {
  const allowed = { ...model, id: "claude-sonnet-5", policy: undefined };
  const denied = {
    ...model,
    id: "claude-opus-5",
    policy: { state: "disabled" },
  };
  const transport = async () => Response.json({ data: [allowed, denied] });
  assert.deepEqual(
    await listModels(async () => "fake", transport, { messages: true }),
    [],
  );
  const listed = await listModels(async () => "fake", transport, {
    messages: true,
    runtimeModelIds: [allowed.id, denied.id],
  });
  assert.deepEqual(
    listed.map((entry) => entry.id),
    [allowed.id],
  );
});

test("Haiku uses its advertised thinking budget without unsupported effort fields", () => {
  const haiku = {
    ...model,
    id: "claude-haiku-4.5",
    capabilities: {
      supports: { max_thinking_budget: 32000 },
      limits: { max_output_tokens: 64000 },
    },
  };
  const request = messagesRequest({ ...payload, model: haiku.id }, haiku);
  assert.deepEqual(request.body.thinking, {
    type: "enabled",
    budget_tokens: 32000,
  });
  assert.equal(request.body.output_config, undefined);
});

test("Messages preserves chronological instructions, images, tool schemas and model settings", () => {
  const request = messagesRequest(
    {
      ...payload,
      input: [
        ...payload.input,
        { role: "developer", content: "New instruction" },
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "data:image/png;base64,YQ==" },
          ],
        },
      ],
    },
    model,
  );
  assert.deepEqual(request.body, {
    model: model.id,
    stream: true,
    cache_control: { type: "ephemeral" },
    max_tokens: 128000,
    thinking: { type: "adaptive" },
    output_config: { effort: "max" },
    system: [
      { type: "text", text: "Be helpful." },
      { type: "text", text: "Follow project instructions." },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Fix the file." },
          {
            type: "text",
            text: "<system-reminder>\nNew instruction\n</system-reminder>",
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "YQ==" },
          },
        ],
      },
    ],
    tools: [
      {
        name: "functions__shell",
        description: "",
        input_schema: payload.tools[0].tools[0].parameters,
      },
      {
        name: "functions__apply_patch",
        description: "Apply a patch.",
        input_schema: {
          type: "object",
          properties: {
            input: {
              type: "string",
              description:
                "The tool's raw input, exactly as described by the tool.",
            },
          },
          required: ["input"],
          additionalProperties: false,
        },
      },
    ],
    tool_choice: { type: "auto" },
  });
});
