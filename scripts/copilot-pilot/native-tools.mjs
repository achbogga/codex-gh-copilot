import { isDeepStrictEqual } from "node:util";
import { requestError } from "./request-errors.mjs";

// Native Responses history can introduce tools incrementally. Other protocols
// need those declarations in their tools field, rather than in sampled history.
// The original payload and persisted native records remain unchanged.
export function expandedNativeTools(payload) {
  if (!Array.isArray(payload.input) || !payload.input.some(item => item.type === "additional_tools"))
    return payload;
  const definitions = [...(payload.tools ?? [])];
  const input = [];
  for (const item of payload.input) {
    if (item.type !== "additional_tools") { input.push(item); continue; }
    if (item.encrypted_content || item.encrypted_function_args?.length ||
        item.content?.some(part => part.type === "encrypted_content"))
      throw requestError("COPILOT_ENCRYPTED_AGENT_MESSAGE");
    if (!Array.isArray(item.tools) || Object.keys(item).some(key =>
      !["type", "id", "role", "tools"].includes(key)))
      throw requestError("COPILOT_INVALID_HISTORY");
    definitions.push(...item.tools);
  }
  const result = [], namespaces = new Map(), tools = new Map();
  const add = (tool, namespace, target) => {
    const key = JSON.stringify([namespace ?? null, tool.name]);
    if (tools.has(key)) {
      if (!isDeepStrictEqual(tools.get(key), tool))
        throw new Error("Conflicting native tool declarations.");
      return;
    }
    tools.set(key, tool);
    target.push(tool);
  };
  for (const tool of definitions) {
    if (tool.type !== "namespace") { add(tool, undefined, result); continue; }
    if (!Array.isArray(tool.tools)) throw requestError("COPILOT_INVALID_HISTORY");
    const { tools: children, ...header } = tool;
    let group = namespaces.get(tool.name);
    if (!group) {
      group = { ...header, tools: [] };
      namespaces.set(tool.name, group); result.push(group);
    } else {
      const { tools: previous, ...priorHeader } = group;
      if (!isDeepStrictEqual(priorHeader, header))
        throw new Error("Conflicting native tool namespaces.");
    }
    for (const child of children) add(child, tool.name, group.tools);
  }
  return { ...payload, tools: result, input };
}

// Codex's default functions namespace can be implicit in saved calls. Resolve
// that alias only when its declaration is unambiguous; never invent a tool.
export function historyToolName(definitions, item) {
  const named = [...definitions].filter(([, tool]) => tool.name === item.name);
  const exact = named.filter(([, tool]) => tool.namespace === item.namespace);
  const matches = exact.length ? exact : named.filter(([, tool]) =>
    [undefined, "functions"].includes(tool.namespace) && [undefined, "functions"].includes(item.namespace));
  if (matches.length > 1) throw new Error("Ambiguous native history tool name.");
  return matches[0]?.[0] ?? (item.namespace && item.namespace !== "functions"
    ? `${item.namespace}__${item.name}` : item.name);
}
