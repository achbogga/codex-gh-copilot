// Forward original bytes, but acknowledge success to the SDK only after a real
// response.completed. Always settle on EOF, read failure, or consumer cancellation.
export function responsesResponse(response) {
  const finished = Promise.withResolvers();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let completed,
    cancelled = false,
    buffer = "";
  const observe = (line) => {
    if (!/^data:\s*\{/.test(line)) return;
    const event = JSON.parse(line.slice(5).trim());
    if (event.type === "response.completed") completed = event;
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value: chunk, done } = await reader.read();
        if (cancelled) return;
        if (done) {
          observe(buffer + decoder.decode());
          if (!completed)
            throw new Error("Incomplete Copilot Responses stream.");
          finished.resolve(completed);
          controller.close();
          return;
        }
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 8 * 1024 * 1024)
          throw new Error("Oversized Copilot event.");
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          observe(buffer.slice(0, end).trimEnd());
          buffer = buffer.slice(end + 1);
        }
        controller.enqueue(chunk);
      } catch (error) {
        finished.resolve(completed ?? null);
        controller.error(error);
        await reader.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      cancelled = true;
      // Codex may stop reading as soon as it sees the terminal event, before EOF.
      finished.resolve(completed ?? null);
      await reader.cancel(reason);
    },
  });
  return {
    response: new Response(body, {
      status: response.status,
      headers: response.headers,
    }),
    completion: finished.promise,
  };
}
