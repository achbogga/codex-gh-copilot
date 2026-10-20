// Map complete SSE data lines, preserving unrelated protocol events and bounds.
export function mapResponseEvents(
  response,
  adapt,
  { dropEventNames = false } = {},
) {
  const line = (value) => {
    if (dropEventNames && value.startsWith("event:")) return "";
    if (value.startsWith("data:") && value.slice(5).trim().startsWith("{")) {
      const event = JSON.parse(value.slice(5));
      const mapped = adapt(event);
      if (mapped !== event) return `data: ${JSON.stringify(mapped)}\n`;
    }
    return value + "\n";
  };
  const decoder = new TextDecoder();
  let buffer = "";
  // Stay in Web Streams so cancellation reaches the upstream reader even when
  // it is awaiting more bytes. Async-generator/Node adapters can leave that
  // read pending and later enqueue into an already closed controller.
  const mapped = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const value = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(value) > 32 * 1024 * 1024)
            throw new Error("Oversized Responses event.");
          controller.enqueue(Buffer.from(line(value)));
        }
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024)
          throw new Error("Oversized Responses event.");
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer)
          controller.enqueue(Buffer.from(line(buffer).replace(/\n$/, "")));
      },
    }),
  );
  return new Response(mapped, {
    status: response.status,
    headers: response.headers,
  });
}
