import { mapResponseEvents } from "./responses-events.mjs";
import { portableAgentMessage, plaintextAgentCall } from "./agent-messages.mjs";

// Keep provenance in saved rollouts as well as in the current bridge process.
// Grok rejects its opaque reasoning on input, even on the same model.
export const responsesThinkingPrefix = "copilot-responses-v1:";

// Grok and MAI expose Responses but accept function tools, rather than Codex's
// custom tools. Keep Codex's tool execution loop; adapt only the wire format.
export function functionToolsRequest(payload) {
  const tools = new Map();
  const add = (tool, namespace) => {
    const name = namespace ? `${namespace}__${tool.name}` : tool.name;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || tools.has(name))
      throw new Error("Unsupported or ambiguous Responses tool name.");
    tools.set(name, { ...tool, namespace });
    if (tool.type === "function") return { ...tool, name };
    if (tool.type !== "custom")
      throw new Error("Unsupported Responses tool type.");
    return {
      type: "function",
      name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description:
              "The tool's exact raw input, as described by the tool.",
          },
        },
        required: ["input"],
        additionalProperties: false,
      },
    };
  };
  const definitions = (payload.tools ?? []).flatMap((tool) =>
    tool.type === "namespace"
      ? tool.tools.map((child) => add(child, tool.name))
      : [add(tool)],
  );
  const input = Array.isArray(payload.input)
    ? payload.input.map((saved) => {
        const item = portableAgentMessage(saved);
        if (item.type === "custom_tool_call_output") {
          const { id, ...copy } = item;
          return { ...copy, type: "function_call_output" };
        }
        if (!["custom_tool_call", "function_call"].includes(item.type))
          return item;
        const name =
          [...tools].find(
            ([, tool]) =>
              tool.name === item.name &&
              (tool.namespace === item.namespace ||
                (!tool.namespace &&
                  [undefined, "functions"].includes(item.namespace))),
          )?.[0] ??
          (item.namespace && item.namespace !== "functions"
            ? `${item.namespace}__${item.name}`
            : item.name);
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name))
          throw new Error("Unsupported Responses history tool name.");
        // A custom call's item ID can have a provider-specific prefix (ctc_).
        // Function endpoints validate fc_ IDs; the optional item ID is not the
        // call_id that associates the saved result with its original call.
        const { input, namespace, id, ...copy } = item;
        return {
          ...copy,
          type: "function_call",
          name,
          arguments:
            item.type === "custom_tool_call"
              ? JSON.stringify({ input })
              : item.arguments,
        };
      })
    : payload.input;
  return { tools, body: { ...payload, tools: definitions, input } };
}

export function functionToolsResponse(response, request) {
  const itemTools = new Map();
  const item = (value, done) => {
    if (value?.type === "reasoning" && value.encrypted_content)
      return {
        ...value,
        encrypted_content: responsesThinkingPrefix + value.encrypted_content,
      };
    if (value?.type !== "function_call") return value;
    const tool = request.tools.get(value.name);
    if (!tool) throw new Error("Unknown Responses output tool.");
    itemTools.set(value.id, tool);
    const copy = {
      ...value,
      name: tool.name,
      ...(tool.namespace ? { namespace: tool.namespace } : {}),
    };
    if (tool.type !== "custom") return plaintextAgentCall(copy);
    let input = "";
    if (done) {
      input = JSON.parse(value.arguments).input;
      if (typeof input !== "string")
        throw new Error("Invalid custom tool input.");
    }
    delete copy.arguments;
    return { ...copy, type: "custom_tool_call", input };
  };
  const adapt = (event) => {
    if (
      ["response.output_item.added", "response.output_item.done"].includes(
        event.type,
      )
    )
      return {
        ...event,
        item: item(event.item, event.type === "response.output_item.done"),
      };
    if (
      [
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
      ].includes(event.type) &&
      itemTools.get(event.item_id)?.type === "custom"
    )
      return { type: "response.in_progress" }; // Execute only the complete, validated input.
    if (event.response?.output)
      return {
        ...event,
        response: {
          ...event.response,
          output: event.response.output.map((value) => item(value, true)),
        },
      };
    return event;
  };
  return mapResponseEvents(response, adapt, { dropEventNames: true });
}
