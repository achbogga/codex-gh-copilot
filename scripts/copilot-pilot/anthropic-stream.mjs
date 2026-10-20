import { thinkingPrefix } from "./anthropic-request.mjs";
import { plaintextAgentCall } from "./agent-messages.mjs";

const maxEventBytes = 32 * 1024 * 1024;
const maxContentBytes = 32 * 1024 * 1024;
const refusalCategories = new Set([
  "cyber",
  "bio",
  "frontier_llm",
  "reasoning_extraction",
  "general_harms",
]);

export function messagesResponse(response, request, { onDiagnostic } = {}) {
  const finished = Promise.withResolvers();
  const started = Promise.withResolvers();
  const encode = (event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  async function* stream() {
    let message,
      block,
      item,
      partial = "",
      buffer = "",
      contentBytes = 0,
      stopped = false,
      receivedEvents = 0,
      lastEvent;
    const output = [],
      decoder = new TextDecoder();
    const event = (type, data = {}) => encode({ type, ...data });
    const itemEvent = (type) =>
      event(type, { output_index: output.length, item });
    const accountContent = (text) => {
      contentBytes += Buffer.byteLength(text);
      if (contentBytes > maxContentBytes)
        throw new Error("Anthropic output content exceeds 32 MiB.");
    };
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trimEnd();
          buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > maxEventBytes)
            throw new Error("Anthropic event exceeds 32 MiB.");
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            if (!stopped)
              throw new Error("Anthropic stream ended before message_stop.");
            continue;
          }
          const value = JSON.parse(data);
          receivedEvents++;
          lastEvent = value.type;
          if (value.copilot_usage && message)
            message.copilot_usage = value.copilot_usage;
          if (value.type === "error") {
            const type = value.error?.type;
            const code =
              {
                api_error: "server_error",
                overloaded_error: "server_is_overloaded",
                timeout_error: "stream_interrupted",
                request_too_large: "context_length_exceeded",
              }[type] ?? "invalid_prompt";
            // In-stream denials are terminal, just like HTTP 4xx. Never turn
            // quota, authentication or policy errors into transport retries.
            yield event("response.failed", {
              response: {
                status: "failed",
                error: { code, message: "Copilot Anthropic inference failed." },
              },
            });
            return;
          }
          if (value.type === "message_start") {
            message = value.message;
            if (value.copilot_usage)
              message.copilot_usage = value.copilot_usage;
            started.resolve(message);
            yield event("response.created", {
              response: { id: message.id, status: "in_progress", output: [] },
            });
          } else if (value.type === "content_block_start") {
            block = value.content_block;
            accountContent(JSON.stringify(block));
            partial = "";
            const id = `${message.id}_${value.index}`;
            if (block.type === "text")
              item = { id, type: "message", role: "assistant", content: [] };
            else if (["thinking", "redacted_thinking"].includes(block.type))
              item = {
                id,
                type: "reasoning",
                summary: [],
                encrypted_content: null,
              };
            else if (block.type === "tool_use") {
              const tool = request.tools.get(block.name);
              if (!tool) throw new Error("Anthropic returned an unknown tool.");
              item = plaintextAgentCall({
                id,
                type:
                  tool.type === "custom" ? "custom_tool_call" : "function_call",
                call_id: block.id,
                name: tool.name,
                ...(tool.namespace ? { namespace: tool.namespace } : {}),
                ...(tool.type === "custom" ? { input: "" } : { arguments: "" }),
              });
            } else
              throw new Error(
                `Unsupported Anthropic output block: ${block.type}`,
              );
            yield itemEvent("response.output_item.added");
          } else if (value.type === "content_block_delta") {
            const delta = value.delta;
            if (delta.type === "text_delta") {
              accountContent(delta.text);
              block.text += delta.text;
              yield event("response.output_text.delta", {
                item_id: item.id,
                output_index: output.length,
                content_index: 0,
                delta: delta.text,
              });
            } else if (delta.type === "input_json_delta") {
              accountContent(delta.partial_json);
              partial += delta.partial_json;
            } else if (delta.type === "thinking_delta") {
              accountContent(delta.thinking);
              block.thinking += delta.thinking;
              // Keep the SSE inactivity timer alive without exposing signed thinking.
              yield event("response.in_progress", {
                response: { id: message.id, status: "in_progress" },
              });
            } else if (delta.type === "signature_delta") {
              accountContent(delta.signature);
              block.signature = (block.signature ?? "") + delta.signature;
            } else
              throw new Error(`Unsupported Anthropic delta: ${delta.type}`);
          } else if (value.type === "content_block_stop") {
            if (block.type === "text")
              item.content = [
                { type: "output_text", text: block.text, annotations: [] },
              ];
            else if (block.type === "tool_use") {
              const input = partial ? JSON.parse(partial) : block.input;
              if (item.type === "custom_tool_call") {
                if (typeof input.input !== "string")
                  throw new Error("Invalid custom tool input.");
                item.input = input.input;
              } else item.arguments = JSON.stringify(input);
            } else
              item.encrypted_content =
                thinkingPrefix +
                Buffer.from(
                  JSON.stringify({
                    model: request.body.model,
                    message_id: message.id,
                    block,
                  }),
                ).toString("base64");
            yield itemEvent("response.output_item.done");
            output.push(item);
          } else if (value.type === "message_delta") {
            Object.assign(message, value.delta);
            Object.assign(message.usage, value.usage);
          } else if (value.type === "message_stop") {
            if (
              !["end_turn", "tool_use", "stop_sequence", "refusal"].includes(
                message.stop_reason,
              )
            )
              throw new Error(
                `Anthropic response stopped: ${message.stop_reason}`,
              );
            const usage = message.usage;
            const input =
              usage.input_tokens +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0);
            const completed = {
              id: message.id,
              status: "completed",
              output,
              usage: {
                input_tokens: input,
                output_tokens: usage.output_tokens,
                total_tokens: input + usage.output_tokens,
                input_tokens_details: {
                  cached_tokens: usage.cache_read_input_tokens ?? 0,
                  cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
                },
              },
            };
            stopped = true;
            finished.resolve({
              ...message,
              stop_reason: "end_turn",
              content: [{ type: "text", text: "Forwarded to Codex." }],
            });
            if (message.stop_reason === "refusal") {
              const category = refusalCategories.has(
                message.stop_details?.category,
              )
                ? message.stop_details.category
                : "unknown";
              try {
                onDiagnostic?.({
                  code: "ANTHROPIC_REFUSAL",
                  category,
                  received_events: receivedEvents,
                });
              } catch {} // Diagnostics cannot change provider accounting.
              // A refusal can follow partial text or tool output. Never label
              // that incomplete answer successful or turn it into a retry.
              // Explanations belong in the user-visible error, not diagnostics.
              const explanation = message.stop_details?.explanation;
              yield event("response.failed", {
                response: {
                  id: message.id,
                  status: "failed",
                  usage: completed.usage,
                  error: {
                    code: "invalid_prompt",
                    message:
                      `Copilot Anthropic refused this request (${category}).` +
                      (typeof explanation === "string" && explanation.trim()
                        ? ` ${explanation.slice(0, 2000)}`
                        : " The provider did not supply an explanation."),
                  },
                },
              });
              return;
            }
            yield event("response.completed", { response: completed });
            return; // message_stop is terminal; EOF and DONE trailers are optional.
          }
        }
        if (Buffer.byteLength(buffer) > maxEventBytes)
          throw new Error("Anthropic event exceeds 32 MiB.");
      }
      if (!stopped) throw new Error("Incomplete Anthropic event stream.");
    } catch (error) {
      try {
        onDiagnostic?.({
          code: "ANTHROPIC_STREAM_FAILED",
          received_events: receivedEvents,
          last_event: [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
            "error",
            "ping",
          ].includes(lastEvent)
            ? lastEvent
            : "unknown",
          failure:
            error.message === "Anthropic returned an unknown tool."
              ? "unknown_tool"
              : error.message === "Invalid custom tool input."
                ? "invalid_custom_input"
                : "incomplete_or_invalid_stream",
          block_type: [
            "tool_use",
            "thinking",
            "redacted_thinking",
            "text",
          ].includes(block?.type)
            ? block.type
            : "unknown",
          ...(block?.type === "tool_use" &&
          /^[a-zA-Z0-9_.-]{1,128}$/.test(block.name)
            ? { tool_name: block.name }
            : {}),
          stop_reason: [
            "end_turn",
            "tool_use",
            "stop_sequence",
            "refusal",
            "max_tokens",
            "pause_turn",
            "model_context_window_exceeded",
          ].includes(message?.stop_reason)
            ? message.stop_reason
            : "unknown",
          output_bytes: contentBytes,
        });
      } catch {} // Metadata-only diagnostics cannot interrupt inference.
      throw error;
    } finally {
      started.resolve(null);
      finished.resolve(null);
    }
  }
  return {
    response: new Response(ReadableStream.from(stream()), {
      headers: { "content-type": "text/event-stream" },
    }),
    completion: finished.promise,
    started: started.promise,
  };
}
