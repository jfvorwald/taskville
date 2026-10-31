// Minimal Server-Sent Events reader over a fetch response body (the engine's frames carry
// `event`, `id`, and one `data` line; contracts/http-api.md).

export interface SseFrame {
  event: string;
  id?: string;
  data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        const frame: SseFrame = { event: "message", data: "" };
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line === "" || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") frame.event = value;
          else if (field === "id") frame.id = value;
          else if (field === "data") data.push(value);
        }
        frame.data = data.join("\n");
        if (data.length > 0 || frame.event !== "message") yield frame;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
