import { mapResponseEvents } from "./responses-events.mjs";
import { thinkingPrefix } from "./anthropic-request.mjs";
import { modelInputLimit } from "./model-config.mjs";

// This is provenance around opaque provider bytes, not decryption or encryption
// with a shared key. The original ciphertext is restored only to its model.
export const modelStatePrefix = "copilot-model-state-v3:";

export function modelStateOwner(item) {
  if (item?.type !== "reasoning" || typeof item.encrypted_content !== "string")
    return undefined;
  const value = item.encrypted_content;
  if (value.startsWith(modelStatePrefix)) {
    const state = value.slice(modelStatePrefix.length),
      end = state.indexOf("\n");
    if (end < 1) throw new Error("Invalid saved Copilot model-state envelope.");
    return decodeURIComponent(state.slice(0, end));
  }
  if (value.startsWith(thinkingPrefix))
    return JSON.parse(
      Buffer.from(value.slice(thinkingPrefix.length), "base64").toString(),
    ).model;
  return undefined;
}

// Codex already selects the source for a smaller total window. Equal/larger
// windows can still have a smaller input allowance. Keep that *native* compact
// request with the source too; never add a second summarization/model call.
export function compactionModel(payload, permittedModels) {
  const current = permittedModels.find((model) => model.id === payload.model);
  let kind = payload.client_metadata?.request_kind;
  if (!kind) {
    try {
      kind = JSON.parse(
        payload.client_metadata?.["x-codex-turn-metadata"] ?? "{}",
      ).request_kind;
    } catch {} // Missing/unknown metadata must not change the selected model.
  }
  if (!current || kind !== "compaction" || !Array.isArray(payload.input))
    return current;
  const owner = payload.input.map(modelStateOwner).findLast(Boolean);
  const source = permittedModels.find((model) => model.id === owner);
  if (
    source &&
    source.id !== current.id &&
    modelInputLimit(source) > modelInputLimit(current)
  )
    return source;
  return current;
}

export function responseHistoryItem(item) {
  const prefix = { custom_tool_call: "ctc", function_call: "fc" }[item.type];
  if (!prefix || !item.id || item.id.startsWith(prefix)) return item;
  // Item IDs belong to the provider. call_id links the actual invocation/result
  // and must remain unchanged in both the native rollout and translated history.
  const { id, ...portable } = item;
  return portable;
}

export function sealModelState(item, model) {
  if (item?.type !== "reasoning" || !item.encrypted_content) return item;
  return {
    ...item,
    encrypted_content: `${modelStatePrefix}${encodeURIComponent(model)}\n${item.encrypted_content}`,
  };
}

export function restoreModelState(item, model) {
  if (!item.encrypted_content?.startsWith(modelStatePrefix)) return item;
  const state = item.encrypted_content.slice(modelStatePrefix.length);
  const end = state.indexOf("\n");
  if (end < 1) throw new Error("Invalid saved Copilot model-state envelope.");
  const owner = modelStateOwner(item);
  // Grok returns opaque reasoning but rejects it on replay, even to itself.
  // Keep it saved locally without sending an input the provider cannot accept.
  if (owner !== model || !model.startsWith("gpt-")) return undefined;
  return { ...item, encrypted_content: state.slice(end + 1) };
}

export function modelStateResponse(response, model) {
  return mapResponseEvents(response, (event) => {
    if (
      ["response.output_item.added", "response.output_item.done"].includes(
        event.type,
      )
    ) {
      const item = sealModelState(event.item, model);
      return item === event.item ? event : { ...event, item };
    }
    if (event.response?.output) {
      const output = event.response.output.map((item) =>
        sealModelState(item, model),
      );
      if (output.some((item, index) => item !== event.response.output[index]))
        return { ...event, response: { ...event.response, output } };
    }
    return event;
  });
}
