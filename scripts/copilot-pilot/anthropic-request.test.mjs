import assert from "node:assert/strict";
import test from "node:test";
import { model, payload } from "./anthropic-fixtures.mjs";
import { messagesRequest } from "./anthropic-request.mjs";
import { listModels } from "./bridge.mjs";

test("unsupported history, tools, foreign thinking and tool-name collisions fail closed", () => {
  for (const change of [
    { input: [{ type: "reasoning", encrypted_content: "foreign" }] },
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
