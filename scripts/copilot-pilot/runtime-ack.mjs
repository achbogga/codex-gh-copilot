// The runtime's buffered JSON reader has a ten-minute read deadline. Return a
// real SSE exchange instead, with progress only when upstream bytes arrive.
// This private acknowledgement never carries Codex's tools or model output.
export function runtimeAcknowledgement(
  started,
  completion,
  onCancel,
  messages = false,
) {
  let controller,
    ready = false,
    settled = false,
    id;
  const emit = (event) =>
    controller.enqueue(
      Buffer.from(
        `${messages ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      ),
    );
  const begin = (information) => {
    if (ready || settled) return;
    if (!information) throw new Error("Copilot inference did not start.");
    ready = true;
    id = information.id ?? "codex-transport-ack";
    if (messages) {
      emit({
        type: "message_start",
        message: { ...information, content: [], stop_reason: null },
      });
      emit({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    } else {
      emit({
        type: "response.created",
        response: { id, status: "in_progress", output: [] },
      });
      emit({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "transport-ack",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
      emit({
        type: "response.content_part.added",
        item_id: "transport-ack",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
  };
  const activity = () => {
    // Bound read-ahead. Do not generate timer-based heartbeats that could hide a
    // stalled provider from the bridge's independent inactivity watchdog.
    if (!ready || settled || controller.desiredSize <= 0) return;
    emit(
      messages
        ? {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "." },
          }
        : {
            type: "response.output_text.delta",
            item_id: "transport-ack",
            output_index: 0,
            content_index: 0,
            delta: ".",
          },
    );
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    controller.error(new Error("Copilot inference did not complete."));
  };
  const body = new ReadableStream({
    start(stream) {
      controller = stream;
      void started.then(begin).catch(fail);
      void completion
        .then((acknowledgement) => {
          if (settled) return;
          begin(acknowledgement);
          if (messages) {
            emit({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Forwarded to Codex." },
            });
            emit({ type: "content_block_stop", index: 0 });
            emit({
              type: "message_delta",
              delta: {
                stop_reason: "end_turn",
                stop_sequence: acknowledgement.stop_sequence ?? null,
              },
              usage: acknowledgement.usage,
              ...(acknowledgement.copilot_usage
                ? { copilot_usage: acknowledgement.copilot_usage }
                : {}),
            });
            emit({ type: "message_stop" });
          } else {
            const item = acknowledgement.output[0];
            emit({
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: item.content[0].text,
            });
            emit({
              type: "response.output_text.done",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              text: item.content[0].text,
            });
            emit({ type: "response.output_item.done", output_index: 0, item });
            emit({
              type: "response.completed",
              response: acknowledgement,
              ...(acknowledgement.copilot_usage
                ? { copilot_usage: acknowledgement.copilot_usage }
                : {}),
            });
          }
          settled = true;
          stream.close();
        })
        .catch(fail);
    },
    cancel() {
      settled = true;
      onCancel();
    },
  });
  return {
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }),
    activity,
  };
}
