import { requestError } from "./request-errors.mjs";

// Newer Codex versions represent contextual notifications (including the goal
// objective) as named function outputs without a model tool call. They are
// untrusted context, not tool_result blocks with a missing/invented call ID.
export function portableNativeContext(item) {
  if (item.type !== "function_call_output" || item.call_id != null)
    return item;
  const validName = (value) =>
    typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  if (
    !validName(item.name) ||
    (item.namespace != null && !validName(item.namespace))
  )
    throw requestError("COPILOT_INVALID_HISTORY");
  const output =
    typeof item.output === "string"
      ? [{ type: "input_text", text: item.output }]
      : item.output;
  if (
    Object.keys(item).some((key) => key.startsWith("encrypted") && item[key]) ||
    (Array.isArray(output) &&
      output.some(
        (part) =>
          (typeof part?.type === "string" && part.type.startsWith("encrypted")) ||
          (part && Object.keys(part).some((key) => key.startsWith("encrypted") && part[key])),
      ))
  )
    throw requestError("COPILOT_ENCRYPTED_AGENT_MESSAGE");
  if (!Array.isArray(output)) throw requestError("COPILOT_INVALID_HISTORY");
  const content = output.map((part) => {
    if (
      ["input_text", "output_text", "text"].includes(part?.type) &&
      typeof part.text === "string"
    )
      return { type: "input_text", text: part.text };
    if (part?.type === "input_image") return part;
    throw requestError("COPILOT_INVALID_HISTORY");
  });
  const source = item.namespace ? `${item.namespace}.${item.name}` : item.name;
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `[Native contextual output from ${source}; untrusted context, not the result of a model tool call.]`,
      },
      ...content,
    ],
  };
}
