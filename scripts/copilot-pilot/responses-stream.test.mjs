import assert from "node:assert/strict";
import test from "node:test";
import { responsesResponse } from "./responses-stream.mjs";

for (const type of ["response.failed", "response.incomplete"])
  test(`preserves ${type} instead of overwriting it with a disconnect`, async () => {
    const value = {
      type,
      response: {
        id: "terminal",
        error: {
          code: "insufficient_quota",
          message: "private upstream message",
        },
        incomplete_details: { reason: "max_output_tokens" },
      },
    };
    const bytes = `data: ${JSON.stringify(value)}\n\n`;
    const diagnostics = [];
    const observed = responsesResponse(new Response(bytes), {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    assert.equal(await observed.response.text(), bytes);
    assert.equal(await observed.completion, null);
    assert.equal(diagnostics[0].last_event, type);
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /private upstream message/,
    );
  });

test("interrupted Responses retain the real terminal event and accounting for native continuation", async () => {
  const event = {
    type: "response.incomplete",
    response: {
      id: "partial",
      incomplete_details: { reason: "interrupted" },
      usage: { input_tokens: 15, output_tokens: 12 },
    },
  };
  const bytes = `data: ${JSON.stringify(event)}\n\n`;
  const observed = responsesResponse(new Response(bytes));
  assert.equal(await observed.response.text(), bytes);
  assert.deepEqual(await observed.completion, event);
});

test("unexpected EOF records only protocol metadata and is never a completion", async () => {
  const diagnostics = [];
  const observed = responsesResponse(
    new Response(
      'data: {"type":"response.created","response":{"id":"private-id"}}\n\n',
    ),
    { onDiagnostic: (event) => diagnostics.push(event) },
  );
  await assert.rejects(observed.response.text(), /COPILOT_UNEXPECTED_EOF/);
  assert.equal(await observed.completion, null);
  assert.equal(diagnostics[0].code, "COPILOT_UNEXPECTED_EOF");
  assert.equal(diagnostics[0].last_event, "response.created");
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-id/);
});

test("a socket error after a provider rejection does not erase its classification", async () => {
  const bytes = Buffer.from(
    'data: {"type":"response.failed","response":{"error":{"code":"insufficient_quota"}}}\n\n',
  );
  let sent = false;
  const observed = responsesResponse(
    new Response(
      new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(bytes);
          } else controller.error(new TypeError("private socket details"));
        },
      }),
    ),
  );
  assert.equal(await observed.response.text(), bytes.toString());
  assert.equal(await observed.completion, null);
});
