import assert from "node:assert/strict";
import test from "node:test";
import { mapResponseEvents } from "./responses-events.mjs";

test("cancelling nested SSE mappings releases a still-open upstream reader", async () => {
  let cancelled = 0;
  const attempts = 50;
  for (let n = 0; n < attempts; n++) {
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            Buffer.from(
              'data: {"type":"response.created"}\n\n' +
                'data: {"type":"response.completed"}\n\n',
            ),
          );
          // A provider may keep the socket open after its terminal event.
        },
        cancel() {
          cancelled++;
        },
      }),
    );
    const mapped = mapResponseEvents(
      mapResponseEvents(upstream, (event) => event),
      (event) => event,
    );
    const reader = mapped.body.getReader();
    while (
      !Buffer.from((await reader.read()).value)
        .toString()
        .includes("response.completed")
    ) {}
    await reader.cancel();
  }
  // pipeThrough propagates cancellation through a microtask on each layer.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, attempts);
});

test("SSE mapping preserves fragmented UTF-8, protocol framing and final lines without a newline", async () => {
  const bytes = Buffer.from(
    'event: response.created\r\ndata: {"type":"response.created","text":"café ✅"}\r\n\r\n' +
      ': progress\ndata: {"type":"response.completed"}',
  );
  const upstream = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  );
  const mapped = mapResponseEvents(upstream, (event) =>
    event.type === "response.created" ? { ...event, adapted: true } : event,
  );
  const text = await mapped.text();
  assert.match(text, /event: response.created\r\n/);
  assert.match(text, /café ✅/);
  assert.match(text, /"adapted":true/);
  assert.ok(text.endsWith('data: {"type":"response.completed"}'));
});
