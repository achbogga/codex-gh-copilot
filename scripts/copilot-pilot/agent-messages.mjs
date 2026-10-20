import { mapResponseEvents } from "./responses-events.mjs";

const messageTools = new Set(["spawn_agent", "send_message", "followup_task"]);
export const agentWireNamespace = "copilot_collaboration";
export const encryptedAgentError =
  "This task contains an OpenAI-encrypted agent message that the selected Copilot model cannot read. Restart cxf and start a new task with the instructions in plain text. The encrypted instructions were not discarded or sent to another provider.";

const incompatible = () =>
  Object.assign(new Error(encryptedAgentError), {
    code: "COPILOT_ENCRYPTED_AGENT_MESSAGE",
  });

export function portableAgentMessage(item) {
  if (item.type !== "agent_message") return item;
  if (item.content.some((part) => part.type === "encrypted_content"))
    throw incompatible();
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `Agent message ${JSON.stringify({ author: item.author, recipient: item.recipient })}:`,
      },
      ...item.content,
    ],
  };
}

// Use Codex's supported plaintext collaboration path. GPT-only ciphertext
// cannot carry a task to Claude/Grok/MAI; no keys or policy checks are bypassed.
export function portableAgentTools(payload) {
  let changed = false;
  if (
    payload.tools?.some(
      (tool) => tool.type === "namespace" && tool.name === agentWireNamespace,
    )
  )
    throw new Error(
      "The Copilot collaboration compatibility namespace is already in use.",
    );
  const adapt = (tool, namespace) => {
    const message = tool.parameters?.properties?.message;
    if (
      namespace !== "collaboration" ||
      !messageTools.has(tool.name) ||
      !message?.encrypted
    )
      return tool;
    changed = true;
    const { encrypted, ...plain } = message;
    return {
      ...tool,
      parameters: {
        ...tool.parameters,
        properties: { ...tool.parameters.properties, message: plain },
      },
    };
  };
  const tools = payload.tools?.map((tool) => {
    if (tool.type !== "namespace") return adapt(tool, tool.namespace);
    if (tool.name === "collaboration") changed = true;
    return {
      ...tool,
      // OpenAI reserves collaboration.* and validates its encrypted schema.
      // Advertise ordinary custom function tools under a distinct wire name.
      name: tool.name === "collaboration" ? agentWireNamespace : tool.name,
      tools: tool.tools.map((child) => adapt(child, tool.name)),
    };
  });
  if (!changed) return payload;
  const input = Array.isArray(payload.input)
    ? payload.input.map((item) =>
        item.type === "function_call" &&
        item.namespace === "collaboration" &&
        !item.encrypted_function_args?.length
          ? { ...item, namespace: agentWireNamespace }
          : item,
      )
    : payload.input;
  return { ...payload, tools, input };
}

export function plaintextAgentCall(item) {
  if (item?.type === "function_call" && item.namespace === agentWireNamespace)
    item = { ...item, namespace: "collaboration" };
  if (
    item?.type !== "function_call" ||
    item.namespace !== "collaboration" ||
    !messageTools.has(item.name)
  )
    return item;
  if (item.encrypted_function_args?.length) throw incompatible();
  // Missing is treated as encrypted by native Codex. An explicit empty array
  // selects ToolCallSource::DirectPlaintextMessage and its native log redaction.
  return item.encrypted_function_args
    ? item
    : { ...item, encrypted_function_args: [] };
}

export function portableAgentResponse(response) {
  return mapResponseEvents(response, (event) => {
    if (
      ["response.output_item.added", "response.output_item.done"].includes(
        event.type,
      )
    ) {
      const item = plaintextAgentCall(event.item);
      return item === event.item ? event : { ...event, item };
    }
    if (event.response?.output) {
      const output = event.response.output.map(plaintextAgentCall);
      if (output.some((item, index) => item !== event.response.output[index]))
        return { ...event, response: { ...event.response, output } };
    }
    return event;
  });
}
