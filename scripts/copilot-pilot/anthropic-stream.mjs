import { Readable } from "node:stream";
import { thinkingPrefix } from "./anthropic-request.mjs";

export function messagesResponse(response, request) {
  const finished = Promise.withResolvers();
  const encode = (event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  async function* stream() {
    let message,
      block,
      item,
      partial = "",
      buffer = "",
      size = 0,
      stopped = false;
    const output = [],
      decoder = new TextDecoder();
    const event = (type, data = {}) => encode({ type, ...data });
    const itemEvent = (type) =>
      event(type, { output_index: output.length, item });
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024)
          throw new Error("Anthropic response exceeds 8 MiB.");
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trimEnd();
          buffer = buffer.slice(end + 1);
          if (!line.startsWith("data: ")) continue;
          const value = JSON.parse(line.slice(6));
          if (value.type === "error")
            throw new Error("Anthropic inference stream failed.");
          if (value.type === "message_start") {
            message = value.message;
            yield event("response.created", {
              response: { id: message.id, status: "in_progress", output: [] },
            });
          } else if (value.type === "content_block_start") {
            block = value.content_block;
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
              item = {
                id,
                type:
                  tool.type === "custom" ? "custom_tool_call" : "function_call",
                call_id: block.id,
                name: tool.name,
                ...(tool.namespace ? { namespace: tool.namespace } : {}),
                ...(tool.type === "custom" ? { input: "" } : { arguments: "" }),
              };
            } else
              throw new Error(
                `Unsupported Anthropic output block: ${block.type}`,
              );
            yield itemEvent("response.output_item.added");
          } else if (value.type === "content_block_delta") {
            const delta = value.delta;
            if (delta.type === "text_delta") {
              block.text += delta.text;
              yield event("response.output_text.delta", {
                item_id: item.id,
                output_index: output.length,
                content_index: 0,
                delta: delta.text,
              });
            } else if (delta.type === "input_json_delta")
              partial += delta.partial_json;
            else if (delta.type === "thinking_delta")
              block.thinking += delta.thinking;
            else if (delta.type === "signature_delta")
              block.signature = (block.signature ?? "") + delta.signature;
            else throw new Error(`Unsupported Anthropic delta: ${delta.type}`);
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
                  JSON.stringify({ model: request.body.model, block }),
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
            if (
              message.stop_reason === "refusal" &&
              !output.some((entry) => entry.type === "message")
            ) {
              item = {
                id: `${message.id}_refusal`,
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: "The model declined this request.",
                    annotations: [],
                  },
                ],
              };
              yield itemEvent("response.output_item.added");
              yield itemEvent("response.output_item.done");
              output.push(item);
            }
            stopped = true;
            yield event("response.completed", { response: completed });
          }
          if (value.copilot_usage && message)
            message.copilot_usage = value.copilot_usage;
        }
      }
      if (!stopped) throw new Error("Incomplete Anthropic event stream.");
      // Acknowledge real usage to the SDK, without asking its agent to run tools.
      finished.resolve({
        ...message,
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Forwarded to Codex." }],
      });
    } finally {
      finished.resolve(null);
    }
  }
  return {
    response: new Response(Readable.toWeb(Readable.from(stream())), {
      headers: { "content-type": "text/event-stream" },
    }),
    completion: finished.promise,
  };
}
