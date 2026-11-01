import { describe, expect, it } from "vitest";
import { type RawFrame, readSseFrames } from "../../src/data/sse.ts";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<RawFrame[]> {
  const frames: RawFrame[] = [];
  for await (const f of readSseFrames(stream)) frames.push(f);
  return frames;
}

describe("readSseFrames", () => {
  it("parses id, event and data fields", async () => {
    const frames = await collect(streamOf('id: 43\nevent: event\ndata: {"a":1}\n\n'));
    expect(frames).toEqual([{ id: "43", event: "event", data: '{"a":1}' }]);
  });

  it("reassembles a frame split across chunks, even inside a multi-byte character", async () => {
    const bytes = new TextEncoder().encode('event: event\ndata: "café"\n\n');
    const at = bytes.length - 4; // between the two UTF-8 bytes of e-acute (0xc3 0xa9)
    expect(bytes[at - 1]).toBe(0xc3);
    expect(bytes[at]).toBe(0xa9);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, at));
        controller.enqueue(bytes.slice(at));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual([{ event: "event", data: '"café"' }]);
  });

  it("handles CRLF line endings and several frames in one chunk", async () => {
    const frames = await collect(
      streamOf(
        'event: heartbeat\r\ndata: {"head":1}\r\n\r\nevent: heartbeat\ndata: {"head":2}\n\n',
      ),
    );
    expect(frames.map((f) => f.data)).toEqual(['{"head":1}', '{"head":2}']);
  });

  it("joins multiple data lines and ignores comments", async () => {
    const frames = await collect(streamOf(": keep-alive\n\nevent: x\ndata: a\ndata: b\n\n"));
    expect(frames).toEqual([{ event: "x", data: "a\nb" }]);
  });

  it("drops a trailing frame that never got its blank line", async () => {
    expect(await collect(streamOf("event: event\ndata: {}\n"))).toEqual([]);
  });

  describe("a CRLF pair split across chunks", () => {
    const wire = 'id: 1\r\nevent: event\r\ndata: {"a":1}\r\n\r\n';
    const expected: RawFrame[] = [{ id: "1", event: "event", data: '{"a":1}' }];

    function splitAt(text: string, at: number): ReadableStream<Uint8Array> {
      const bytes = new TextEncoder().encode(text);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, at));
          controller.enqueue(bytes.slice(at));
          controller.close();
        },
      });
    }

    it.each([
      ["after the CR ending the id line", wire.indexOf("\r") + 1],
      ["after the CR ending the event line", wire.indexOf("\r", wire.indexOf("\r") + 1) + 1],
      ["after the CR ending the data line", wire.indexOf("\r\n\r\n") + 1],
      ["after the CR of the final blank line", wire.length - 1],
    ])("parses one whole frame when split %s", async (_name, at) => {
      expect(wire[at - 1]).toBe("\r");
      expect(wire[at]).toBe("\n");
      expect(await collect(splitAt(wire, at))).toEqual(expected);
    });

    it("parses one whole frame whichever byte the chunk boundary falls on", async () => {
      for (let at = 1; at < wire.length; at += 1) {
        expect(await collect(splitAt(wire, at)), `split at ${at}`).toEqual(expected);
      }
    });

    it("parses one whole frame when every byte arrives in its own chunk", async () => {
      expect(await collect(streamOf(...wire.split("")))).toEqual(expected);
    });
  });
});
