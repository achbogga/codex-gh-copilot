import assert from "node:assert/strict";
import test from "node:test";
import {
  sealModelState,
  restoreModelState,
  modelStateResponse,
  modelStatePrefix,
  responseHistoryItem,
  compactionModel,
} from "./model-state.mjs";
import { thinkingPrefix, messagesRequest } from "./anthropic-request.mjs";
import { model as claude } from "./anthropic-fixtures.mjs";

const models = [
  "claude-opus-4.8",
  "claude-opus-5.5",
  "claude-opus-5",
  "claude-sonnet-5.5",
  "claude-sonnet-5",
  "claude-haiku-4.5",
  "gpt-5.3-codex",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-6-sol",
  "grok-4.6",
  "grok-4.7",
  "mai-code-1.1-flash",
];

test("native compaction stays with its source when total windows match but input budgets shrink", () => {
  const source = {
    id: "gpt-source",
    capabilities: {
      limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 936000 },
    },
  };
  const destination = {
    id: "gpt-destination",
    capabilities: {
      limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 872000 },
    },
  };
  const input = [
    sealModelState(
      { type: "reasoning", encrypted_content: "provider-original" },
      source.id,
    ),
    { role: "user", content: "Compact the current conversation." },
  ];
  const payload = {
    model: destination.id,
    input,
    client_metadata: { request_kind: "compaction" },
  };
  assert.equal(compactionModel(payload, [source, destination]), source);
  assert.equal(
    compactionModel(
      {
        ...payload,
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
      },
      [source, destination],
    ),
    source,
  );
  assert.equal(
    compactionModel(
      { ...payload, client_metadata: { "x-codex-turn-metadata": "broken" } },
      [source, destination],
    ),
    destination,
  );
  assert.equal(
    compactionModel({ ...payload, client_metadata: {} }, [source, destination]),
    destination,
  );
  assert.equal(compactionModel(payload, [destination]), destination);
  assert.equal(
    compactionModel(
      {
        ...payload,
        input: [{ role: "user", content: "CONTEXT CHECKPOINT COMPACTION" }],
      },
      [source, destination],
    ),
    destination,
  );
  assert.equal(
    compactionModel({ ...payload, model: source.id }, [source, destination]),
    source,
  );
  const largeOutput = {
    ...destination,
    capabilities: {
      limits: {
        max_context_window_tokens: 1000000,
        max_prompt_tokens: 936000,
        max_output_tokens: 128000,
      },
    },
  };
  assert.equal(compactionModel(payload, [source, largeOutput]), source);
  const claude = { ...source, id: "claude-source" };
  const thinking = {
    type: "reasoning",
    encrypted_content:
      thinkingPrefix +
      Buffer.from(
        JSON.stringify({
          model: claude.id,
          block: { type: "thinking", thinking: "", signature: "unchanged" },
        }),
      ).toString("base64"),
  };
  assert.equal(
    compactionModel({ ...payload, input: [thinking, input[1]] }, [
      claude,
      destination,
    ]),
    claude,
  );
});

test("all 256 ownership pairs preserve opaque state and restore native GPT state across GPT switches after restart", () => {
  let checked = 0;
  for (const source of models)
    for (const target of models) {
      const original = {
        type: "reasoning",
        id: "rs_item",
        summary: [],
        encrypted_content: "original-opaque-bytes\n+/=é:provider-state",
      };
      const archived = JSON.parse(
        JSON.stringify(sealModelState(original, source)),
      );
      const restored = restoreModelState(archived, target);
      if (source.startsWith("gpt-") && target.startsWith("gpt-"))
        assert.deepEqual(restored, original);
      else assert.equal(restored, undefined);
      assert.equal(
        archived.encrypted_content,
        sealModelState(original, source).encrypted_content,
      );
      assert.equal(
        original.encrypted_content,
        "original-opaque-bytes\n+/=é:provider-state",
      );
      checked++;
    }
  assert.equal(checked, 256);
});

test("Claude signed thinking survives JSON session storage and is replayed natively to Claude models", () => {
  const claudes = models.filter((id) => id.startsWith("claude-"));
  for (const source of claudes)
    for (const target of claudes) {
      const block = {
        type: "thinking",
        thinking: "PRIVATE_SIGNED_THINKING",
        signature: "UNCHANGED_PROVIDER_SIGNATURE",
      };
      const saved = JSON.parse(
        JSON.stringify({
          type: "reasoning",
          encrypted_content:
            thinkingPrefix +
            Buffer.from(JSON.stringify({ model: source, block })).toString(
              "base64",
            ),
        }),
      );
      const request = messagesRequest(
        {
          model: target,
          input: [saved, { role: "user", content: "Continue" }],
        },
        { ...claude, id: target },
      );
      const blocks = request.body.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === "thinking");
      assert.deepEqual(blocks, [block]); // The provider enforces readability.
    }
});

test("ownership adds constant overhead for a large opaque reasoning item without base64 expansion", () => {
  const original = {
    type: "reasoning",
    encrypted_content: "q".repeat(1024 * 1024),
  };
  const saved = sealModelState(original, "gpt-6.1-sol");
  assert.ok(
    saved.encrypted_content.length - original.encrypted_content.length < 100,
  );
  assert.deepEqual(restoreModelState(saved, "gpt-6.1-sol"), original);
});

test("stream ownership preserves tool events, token accounting, billing and the original encrypted bytes", async () => {
  const reasoning = {
    type: "reasoning",
    id: "rs_saved",
    encrypted_content: "secret-provider-bytes",
  };
  const tool = {
    type: "custom_tool_call",
    id: "ctc_tool",
    call_id: "call-result-link",
    name: "exec",
    input: "text(1);",
  };
  const event = {
    type: "response.completed",
    response: {
      id: "resp_test",
      output: [reasoning, tool],
      usage: { input_tokens: 200, output_tokens: 25 },
    },
    copilot_usage: { total_nano_aiu: 17 },
  };
  const result = JSON.parse(
    (
      await modelStateResponse(
        new Response(`data: ${JSON.stringify(event)}\n\n`),
        "gpt-6.1-sol",
      ).text()
    ).slice(6),
  );
  assert.deepEqual(result.response.output[1], tool);
  assert.deepEqual(result.response.usage, event.response.usage);
  assert.deepEqual(result.copilot_usage, event.copilot_usage);
  assert.deepEqual(
    restoreModelState(result.response.output[0], "gpt-6.1-sol"),
    reasoning,
  );
});

test("GPT wire history retains call/result links while discarding incompatible provider item IDs", () => {
  for (const type of ["function_call", "custom_tool_call"]) {
    const original = {
      type,
      id: "msg_anthropic_2",
      call_id: "toolu_original",
      arguments: "{}",
    };
    assert.deepEqual(responseHistoryItem(original), {
      type,
      call_id: "toolu_original",
      arguments: "{}",
    });
    assert.equal(original.id, "msg_anthropic_2");
  }
  const native = {
    type: "custom_tool_call",
    id: "ctc_native",
    call_id: "call_native",
  };
  assert.equal(responseHistoryItem(native), native);
  assert.throws(() =>
    restoreModelState(
      { encrypted_content: modelStatePrefix + "broken" },
      "gpt-6.1-sol",
    ),
  );
});
