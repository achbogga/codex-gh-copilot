export const model = {
  id: "claude-opus-5.5",
  policy: { state: "enabled" },
  model_picker_enabled: true,
  supported_endpoints: ["/v1/messages"],
  capabilities: {
    supports: {
      tool_calls: true,
      streaming: true,
      reasoning_effort: ["high", "max"],
    },
    limits: {
      max_context_window_tokens: 1000000,
      max_prompt_tokens: 1000000,
      max_output_tokens: 128000,
    },
  },
};
export const payload = {
  model: model.id,
  instructions: "Be helpful.",
  reasoning: { effort: "max" },
  tools: [
    {
      type: "namespace",
      name: "functions",
      tools: [
        {
          type: "function",
          name: "shell",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
          },
        },
        { type: "custom", name: "apply_patch", description: "Apply a patch." },
      ],
    },
  ],
  input: [
    { role: "developer", content: "Follow project instructions." },
    { role: "user", content: "Fix the file." },
  ],
};
