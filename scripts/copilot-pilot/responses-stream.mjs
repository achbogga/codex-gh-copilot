// Preserve Responses events and acknowledge only a genuine completed/interrupted
// terminal response. Never turn an unexpected EOF into a successful completion.
const maxEventBytes = 32 * 1024 * 1024;

export function responsesResponse(
  response,
  { onDiagnostic = () => {}, onReasoning = () => {} } = {},
) {
  const finished = Promise.withResolvers();
  const started = Promise.withResolvers();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let completed,
    terminal,
    pendingFailure,
    lastEvent = "none",
    bytes = 0,
    events = 0,
    cancelled = false,
    buffer = "";
  const observe = (line) => {
    if (Buffer.byteLength(line) > maxEventBytes)
      throw new Error("Oversized Copilot event.");
    if (!/^data:\s*\{/.test(line)) return;
    const event = JSON.parse(line.slice(5).trim());
    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "reasoning"
    )
      onReasoning(event.item);
    if (event.type === "response.completed")
      for (const item of event.response?.output ?? [])
        if (item.type === "reasoning") onReasoning(item);
    if (
      [
        "response.created",
        "response.completed",
        "response.incomplete",
      ].includes(event.type)
    )
      started.resolve(event.response ?? {});
    events++;
    // Only protocol names, counts and allowlisted reasons enter diagnostics.
    lastEvent =
      typeof event.type === "string" &&
      event.type.length < 80 &&
      /^response\.[a-z_.]+$/.test(event.type)
        ? event.type
        : "other";
    if (event.type === "response.completed") completed = event;
    if (
      [
        "response.completed",
        "response.failed",
        "response.incomplete",
        "error",
      ].includes(event.type)
    ) {
      terminal = event.type;
      if (
        event.type === "response.incomplete" &&
        event.response?.incomplete_details?.reason === "interrupted"
      )
        completed = event;
      // The terminal event is sufficient. Waiting for EOF can deadlock the SDK
      // acknowledgement when the provider keeps its HTTP connection open.
      if (completed) finished.resolve(completed);
      if (!completed) {
        const errorCodes = [
          "server_error",
          "internal_server_error",
          "server_is_overloaded",
          "context_length_exceeded",
          "insufficient_quota",
          "rate_limit_exceeded",
          "invalid_prompt",
          "content_filter",
          "cyber_policy",
          "bio_policy",
          "misalignment_policy_violation",
        ];
        const code = (event.response?.error ?? event.error ?? event)?.code;
        const reason = event.response?.incomplete_details?.reason;
        try {
          onDiagnostic({
            code: "UPSTREAM_TERMINAL_EVENT",
            last_event: lastEvent,
            upstream_code: errorCodes.includes(code) ? code : "unknown",
            incomplete_reason: [
              "interrupted",
              "max_output_tokens",
              "content_filter",
            ].includes(reason)
              ? reason
              : null,
            bytes,
            events,
          });
        } catch {}
        if (event.type === "error") {
          // Codex ignores most generic error events. Give it a classified
          // Responses failure; unknown rejections fail closed without retries.
          const failureCode =
            errorCodes.includes(code) && code !== "content_filter"
              ? code
              : "invalid_prompt";
          pendingFailure = Buffer.from(
            `\n\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: failureCode, message: `Copilot returned an inference error (${errorCodes.includes(code) ? code : "unclassified rejection"}).` } } })}\n\n`,
          );
        }
      }
    }
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { value: chunk, done } = await reader.read();
        if (cancelled) return;
        if (done) {
          observe(buffer + decoder.decode());
          started.resolve(null);
          if (!terminal) {
            const error = new Error(
              "Copilot closed the stream without a terminal event.",
            );
            error.code = "COPILOT_UNEXPECTED_EOF";
            throw error;
          }
          // A real provider failure must reach Codex unchanged. Do not replace
          // it with a generic disconnect or discard its queued final chunk.
          finished.resolve(completed ?? null);
          if (pendingFailure) controller.enqueue(pendingFailure);
          controller.close();
          return;
        }
        bytes += chunk.length;
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          observe(buffer.slice(0, end).trimEnd());
          buffer = buffer.slice(end + 1);
        }
        if (Buffer.byteLength(buffer) > maxEventBytes)
          throw new Error("Oversized Copilot event.");
        controller.enqueue(chunk);
        if (pendingFailure) {
          controller.enqueue(pendingFailure);
          pendingFailure = undefined;
        }
      } catch (error) {
        if (cancelled) return;
        started.resolve(null);
        const known = [
          "COPILOT_UNEXPECTED_EOF",
          "COPILOT_ENCRYPTED_AGENT_MESSAGE",
          "UND_ERR_SOCKET",
          "UND_ERR_BODY_TIMEOUT",
          "ECONNRESET",
          "ETIMEDOUT",
          "ABORT_ERR",
        ];
        const code =
          [error.code, error.cause?.code].find((value) =>
            known.includes(value),
          ) ??
          (error.name === "SyntaxError"
            ? "INVALID_SSE_JSON"
            : error.name === "AbortError"
              ? "ABORT_ERR"
              : "STREAM_READ_ERROR");
        try {
          onDiagnostic({
            code,
            last_event: lastEvent,
            bytes,
            events,
            terminal: terminal ?? null,
          });
        } catch {}
        finished.resolve(completed ?? null);
        if (terminal) {
          // A trailing socket error cannot erase a terminal event already read.
          if (pendingFailure) controller.enqueue(pendingFailure);
          controller.close();
        } else
          controller.error(
            Object.assign(new Error(`Copilot stream interrupted (${code}).`), {
              code,
            }),
          );
        await reader.cancel(error).catch(() => {});
      }
    },
    async cancel(reason) {
      cancelled = true;
      started.resolve(null);
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
    started: started.promise,
  };
}
