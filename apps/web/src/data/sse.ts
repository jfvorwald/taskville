/** One server-sent-events frame as written on the wire, before any JSON parsing. */
export interface RawFrame {
  event?: string;
  id?: string;
  data?: string;
}

/**
 * Reads SSE frames from a fetch body. A frame ends at a blank line; a trailing partial frame
 * (the connection dropped mid-frame) is discarded, never half-applied. Comments (`:`) and
 * `retry:` are ignored. Reconnection is the caller's job, because it must resume from its own
 * cursor rather than the browser's `EventSource` rules.
 */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<RawFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // A chunk can end between the "\r" and "\n" of one CRLF, so a trailing "\r" waits for the next
  // chunk. At stream end a held "\r" is a lone "\r", which ends a line.
  let heldCr = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      let text = heldCr + (done ? "" : decoder.decode(value, { stream: true }));
      heldCr = "";
      if (!done && text.endsWith("\r")) {
        heldCr = "\r";
        text = text.slice(0, -1);
      }
      buffer += text.replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const frame = parseFrame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (frame !== undefined) yield frame;
        end = buffer.indexOf("\n\n");
      }
      if (done) return;
    }
  } finally {
    // Stops the download when the consumer leaves early (abort, resnapshot, bad frame).
    reader.cancel().catch(() => {});
  }
}

function parseFrame(text: string): RawFrame | undefined {
  const frame: RawFrame = {};
  const data: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") frame.event = value;
    else if (field === "id") frame.id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length > 0) frame.data = data.join("\n");
  return frame.event === undefined && frame.data === undefined ? undefined : frame;
}
