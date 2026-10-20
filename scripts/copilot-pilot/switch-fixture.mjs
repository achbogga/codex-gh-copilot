import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const encode = (event) => `data: ${JSON.stringify(event)}\n\n`;

// Synthetic inference only: native Codex still executes actual shell/patch tools.
// Reported token counts exercise control flow, not real model capacity.
export function switchFixture(models, { nearLimit = false } = {}) {
  const definitions = new Map();
  return async (request) => {
    const body = await request.json(),
      model = models.find((m) => m.id === body.model);
    assert.ok(model);
    const messages = new URL(request.url).pathname === "/v1/messages";
    const history = messages ? body.messages : body.input;
    const all = JSON.stringify(history);
    const historyMarkers = [
      ...new Set(all.match(/MATRIX_HISTORY_[a-f0-9]{20}/g) ?? []),
    ];
    const targetMarkers = [
      ...new Set(all.match(/MATRIX_TARGET_[a-f0-9]{20}/g) ?? []),
    ];
    const patchMarkers = [
      ...new Set(all.match(/PATCH_AFTER_[a-zA-Z0-9_-]+/g) ?? []),
    ];
    for (const value of history ?? []) {
      if (value.type === "reasoning")
        assert.ok(
          models.some(
            (source) =>
              source.id.startsWith("gpt-") &&
              value.encrypted_content === `fixture-private:${source.id}`,
          ),
          "GPT receives original GPT state and enforces family compatibility itself.",
        );
      for (const block of value.content ?? [])
        if (block.type === "thinking")
          assert.ok(
            models.some(
              (source) =>
                source.supported_endpoints?.includes("/v1/messages") &&
                block.signature === `fixture-signature:${source.id}`,
            ),
            "Claude accepts valid signed blocks and decides model readability itself.",
          );
    }
    const last = history?.at(-1);
    const afterTool = messages
      ? last?.content?.some((part) => part.type === "tool_result")
      : ["function_call_output", "custom_tool_call_output"].includes(
          last?.type,
        );
    const isCompact = all.includes("CONTEXT CHECKPOINT COMPACTION");
    const visible =
      (history ?? [])
        .filter((m) => m.role === "user")
        .flatMap((m) =>
          typeof m.content === "string"
            ? [m.content]
            : (m.content ?? [])
                .filter((c) => ["input_text", "text"].includes(c.type))
                .map((c) => c.text),
        )
        .at(-1) ?? "";
    const source = /Use shell to read (\S+\.txt)\. Remember/.exec(visible);
    const target = /Use shell to read (\S+\.txt) and (\S+\.txt)\./.exec(
      visible,
    );
    let code;
    if (!isCompact && !afterTool && source) {
      const patch = /replace PATCH_BEFORE in (\S+) with (\S+)\./.exec(visible);
      assert.ok(patch);
      const diff = `*** Begin Patch\n*** Update File: ${patch[1]}\n@@\n-PATCH_BEFORE\n+${patch[2]}\n*** End Patch`;
      code = `text(await tools.exec_command({cmd:${JSON.stringify("cat " + quote(source[1]))}})); text(await tools.apply_patch(${JSON.stringify(diff)}));`;
    } else if (!isCompact && !afterTool && target) {
      code = `text(await tools.exec_command({cmd:${JSON.stringify("cat " + quote(target[1]) + " " + quote(target[2]))}}));`;
    }
    const declarations = [
      ...(body.tools ?? []),
      ...(!messages
        ? (body.input ?? []).flatMap((item) =>
            item.type === "additional_tools" ? item.tools : [],
          )
        : []),
    ];
    const flattened = declarations.flatMap((tool) =>
      tool.type === "namespace"
        ? tool.tools.map((child) => ({ ...child, namespace: tool.name }))
        : [tool],
    );
    let tool = flattened.find(
      (t) => t.name === "exec" || t.name === "functions__exec",
    );
    if (tool) definitions.set(model.id, tool);
    tool ??= definitions.get(model.id);
    if (code)
      assert.ok(
        tool,
        "The fixture needs native exec: " +
          JSON.stringify({
            keys: Object.keys(body),
            tools: flattened.map((t) => ({
              type: t.type,
              name: t.name,
              namespace: t.namespace,
            })),
          }),
      );
    const output = isCompact
      ? `Native source-model summary. Preserve these exact remembered markers: ${historyMarkers.join(" ")}. Artifacts were patched. The pending task must read its proof file with shell.`
      : [...historyMarkers, ...targetMarkers, ...patchMarkers].join(" ");
    const id = randomBytes(10).toString("hex");
    const limit = Math.floor(
      Math.min(
        model.capabilities.limits.max_prompt_tokens,
        model.capabilities.limits.max_context_window_tokens -
          (model.capabilities.limits.max_output_tokens ?? 0),
      ) * 0.95,
    );
    const inputTokens =
      nearLimit && !code && !isCompact && source
        ? Math.max(1, limit - 1200)
        : 100;
    if (messages) {
      const blocks = [
        {
          type: "thinking",
          thinking: "fixture-private",
          signature: `fixture-signature:${model.id}`,
        },
        code
          ? {
              type: "tool_use",
              id: "call_" + id,
              name: tool.name,
              input: { input: code },
            }
          : { type: "text", text: output },
      ];
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_" + id,
            type: "message",
            role: "assistant",
            model: model.id,
            usage: { input_tokens: inputTokens, output_tokens: 1 },
          },
        },
      ];
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        events.push({
          type: "content_block_start",
          index,
          content_block: block,
        });
        events.push({ type: "content_block_stop", index });
      }
      events.push(
        {
          type: "message_delta",
          delta: { stop_reason: code ? "tool_use" : "end_turn" },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      );
      return new Response(events.map(encode).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    const item = code
      ? tool.type === "custom"
        ? {
            id: "ctc_" + id,
            type: "custom_tool_call",
            name: tool.name,
            namespace: tool.namespace,
            call_id: "call_" + id,
            input: code,
          }
        : {
            id: "fc_" + id,
            type: "function_call",
            name: tool.name,
            call_id: "call_" + id,
            arguments: JSON.stringify({ input: code }),
          }
      : {
          id: "msg_" + id,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: output, annotations: [] }],
        };
    const reasoning = {
      id: "rs_" + id,
      type: "reasoning",
      summary: [],
      encrypted_content: `fixture-private:${model.id}`,
    };
    const events = [
      {
        type: "response.created",
        response: { id: "resp_" + id, model: model.id, status: "in_progress" },
      },
      { type: "response.output_item.done", item: reasoning },
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id: "resp_" + id,
          model: model.id,
          status: "completed",
          output: [reasoning, item],
          usage: {
            input_tokens: inputTokens,
            output_tokens: 1,
            total_tokens: inputTokens + 1,
          },
        },
      },
    ];
    return new Response(events.map(encode).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
}
