import { portableAgentMessage } from "./agent-messages.mjs";

// The seat catalog owns protocol selection, rather than a fixed model name.
export const usesMessages = (model) =>
  model?.supported_endpoints?.includes("/v1/messages") === true &&
  !model.supported_endpoints.includes("/responses");

export const thinkingPrefix = "copilot-anthropic-v1:";
const continuation = {
  type: "text",
  text: "Continue the pending task from the conversation above. Return the visible answer or the required tool call.",
};

function toolName(name, namespace) {
  const value = namespace ? `${namespace}__${name}` : name;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error("Unsupported Anthropic tool name.");
  return value;
}

function content(value) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return value.map((part) => {
    if (["input_text", "output_text", "text"].includes(part.type))
      return { type: "text", text: part.text };
    if (part.type === "input_image") {
      const data = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
        part.image_url,
      );
      if (data)
        return {
          type: "image",
          source: { type: "base64", media_type: data[1], data: data[2] },
        };
      if (part.image_url?.startsWith("https://"))
        return { type: "image", source: { type: "url", url: part.image_url } };
    }
    throw new Error(`Unsupported Anthropic content: ${part.type}`);
  });
}

export function messagesRequest(payload, model) {
  if (
    payload.previous_response_id ||
    (payload.text?.format?.type && payload.text.format.type !== "text")
  )
    throw new Error("Anthropic requires full history and plain text output.");
  const tools = new Map();
  const addTool = (tool, namespace) => {
    if (!["function", "custom"].includes(tool.type))
      throw new Error(`Unsupported Anthropic tool type: ${tool.type}`);
    const name = toolName(tool.name, namespace);
    if (tools.has(name)) throw new Error("Ambiguous Anthropic tool name.");
    tools.set(name, { ...tool, namespace });
    return {
      name,
      description: tool.description ?? "",
      input_schema:
        tool.type === "custom"
          ? {
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
            }
          : tool.parameters,
    };
  };
  const definitions = (payload.tools ?? []).flatMap((tool) =>
    tool.type === "namespace"
      ? tool.tools.map((child) => addTool(child, tool.name))
      : [addTool(tool)],
  );
  const messages = [];
  const system = payload.instructions ? content(payload.instructions) : [];
  const append = (role, blocks) => {
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  let assistantMessageId;
  const assistantBoundary = (id) => {
    if (
      id &&
      assistantMessageId &&
      id !== assistantMessageId &&
      messages.at(-1)?.role === "assistant"
    )
      append("user", [{ ...continuation }]);
    if (id) assistantMessageId = id;
  };
  // Native history stores each block separately. Reconstruct provider message
  // boundaries as well as their signed bytes, including thinking-only turns.
  const providerMessageId = (item) =>
    /^msg_.+_\d+$/.test(item.id ?? "")
      ? item.id.replace(/_\d+$/, "")
      : undefined;
  const input =
    typeof payload.input === "string"
      ? [{ role: "user", content: payload.input }]
      : payload.input;
  for (const saved of input) {
    const item = portableAgentMessage(saved);
    if (item.type === "message" || (!item.type && item.role)) {
      const blocks = content(item.content);
      if (["developer", "system"].includes(item.role)) {
        if (!messages.length) system.push(...blocks);
        else
          append(
            "user",
            blocks.map((block) => {
              if (block.type !== "text")
                throw new Error("Non-text developer instruction.");
              return {
                type: "text",
                text: `<system-reminder>\n${block.text}\n</system-reminder>`,
              };
            }),
          );
      } else if (["user", "assistant"].includes(item.role)) {
        if (item.role === "assistant")
          assistantBoundary(providerMessageId(item));
        append(item.role, blocks);
      } else throw new Error("Unsupported Anthropic message role.");
    } else if (item.type === "reasoning") {
      if (!item.encrypted_content?.startsWith(thinkingPrefix)) continue; // Opaque reasoning belongs to its original provider, not the new model.
      const saved = JSON.parse(
        Buffer.from(
          item.encrypted_content.slice(thinkingPrefix.length),
          "base64",
        ).toString(),
      );
      if (saved.model !== payload.model) continue;
      if (!["thinking", "redacted_thinking"].includes(saved.block?.type))
        throw new Error("Incompatible Anthropic thinking block.");
      assistantBoundary(saved.message_id ?? providerMessageId(item));
      append("assistant", [saved.block]);
    } else if (["function_call", "custom_tool_call"].includes(item.type)) {
      assistantBoundary(providerMessageId(item));
      append("assistant", [
        {
          type: "tool_use",
          id: item.call_id,
          name: toolName(item.name, item.namespace),
          input:
            item.type === "custom_tool_call"
              ? { input: item.input }
              : JSON.parse(item.arguments),
        },
      ]);
    } else if (
      ["function_call_output", "custom_tool_call_output"].includes(item.type)
    ) {
      append("user", [
        {
          type: "tool_result",
          tool_use_id: item.call_id,
          content: content(item.output),
        },
      ]);
    } else throw new Error(`Unsupported Anthropic history item: ${item.type}`);
  }
  // Native sampling may continue after an assistant-only reasoning response.
  // Messages models reject assistant prefill; retain that response and supply
  // the user continuation required by their protocol instead of losing state.
  if (messages.at(-1)?.role === "assistant")
    append("user", [{ ...continuation }]);
  if (
    [...tools.values()].some(
      (tool) => tool.type === "custom" && tool.name === "exec",
    )
  )
    system.push({
      type: "text",
      text: "Native Code Mode tool I/O: functions.exec accepts JavaScript, not shell syntax. Call only tools advertised in this request. Inside functions.exec, use text(await tools.exec_command(...)) to print shell results, and text(await tools.apply_patch(patchString)) to apply a patch. Awaiting a tool alone does not print its result. An empty Script completed Output is not evidence that files are empty when the script did not call text(). Direct native tools are also available when advertised. Preserve and use the complete visible session, including prior tool calls and results.",
    });
  if (payload.tool_choice && !["auto", "none"].includes(payload.tool_choice))
    throw new Error("Opus 5.5 supports auto or none tool choice.");
  return {
    tools,
    body: {
      model: payload.model,
      stream: true,
      cache_control: { type: "ephemeral" },
      max_tokens: Math.min(
        payload.max_output_tokens ??
          model.capabilities.limits.max_output_tokens,
        model.capabilities.limits.max_output_tokens,
      ),
      ...(model.capabilities.supports.adaptive_thinking !== false &&
      model.capabilities.supports.reasoning_effort?.length
        ? {
            thinking: { type: "adaptive" },
            output_config: { effort: payload.reasoning?.effort ?? "max" },
          }
        : {
            thinking: {
              type: "enabled",
              budget_tokens: Math.min(
                model.capabilities.supports.max_thinking_budget ?? 32000,
                (payload.max_output_tokens ??
                  model.capabilities.limits.max_output_tokens) - 1,
              ),
            },
          }),
      system,
      messages,
      ...(definitions.length
        ? {
            tools: definitions,
            tool_choice: { type: payload.tool_choice ?? "auto" },
          }
        : {}),
    },
  };
}
