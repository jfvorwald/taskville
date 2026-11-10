// The Worker's SSE framer must match the engine's (Hono's `writeSSE`) byte for byte.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describe, expect, it } from "vitest";
import { formatSse } from "../src/sse.ts";

interface Message {
  event: string | undefined;
  data: string;
  id: string | undefined;
}

/** What Hono writes for one message, read back as text. */
async function honoBytes(message: Message): Promise<string> {
  const app = new Hono().get("/", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({
        data: message.data,
        ...(message.event === undefined ? {} : { event: message.event }),
        ...(message.id === undefined ? {} : { id: message.id }),
      });
    }),
  );
  return (await app.request("/")).text();
}

const cases: [string, Message][] = [
  ["event with id", { event: "event", data: '{"a":1}', id: "7" }],
  ["idless frame", { event: "heartbeat", data: '{"head":3}', id: undefined }],
  ["multi-line data (LF)", { event: "event", data: "one\ntwo\nthree", id: "12" }],
  ["multi-line data (CRLF and CR)", { event: "event", data: "a\r\nb\rc", id: "1" }],
  ["empty data", { event: "snapshot", data: "", id: undefined }],
  ["trailing newline in data", { event: "event", data: "line\n", id: "2" }],
  ["unicode data", { event: "attention", data: '{"name":"café 🏙"}', id: undefined }],
];

describe("formatSse", () => {
  for (const [name, message] of cases) {
    it(`matches Hono's writeSSE byte for byte: ${name}`, async () => {
      const expected = await honoBytes(message);
      expect(
        formatSse({
          event: message.event ?? "",
          data: message.data,
          ...(message.id === undefined ? {} : { id: message.id }),
        }),
      ).toBe(expected);
    });
  }
});
