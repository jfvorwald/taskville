// A minimal stdio MCP server for the live run (M2.10): one tool, `ask_name`, whose call sends an
// `elicitation/create` request to the client, so Claude Code fires the `Elicitation` hook.
// Newline-delimited JSON-RPC 2.0 on stdin and stdout, no dependencies.

import { createInterface } from "node:readline";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pending = new Map();
let next = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // A response to our elicitation request.
  if (msg.method === undefined && pending.has(msg.id)) {
    const callId = pending.get(msg.id);
    pending.delete(msg.id);
    const text = JSON.stringify(msg.result ?? { error: msg.error ?? null });
    send({ id: callId, result: { content: [{ type: "text", text }] } });
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "elic", version: "0.0.1" },
        },
      });
      return;
    case "tools/list":
      send({
        id: msg.id,
        result: {
          tools: [
            {
              name: "ask_name",
              description: "Asks the user which name to use, then returns the answer.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
      return;
    case "tools/call": {
      const id = `elicit-${next++}`;
      pending.set(id, msg.id);
      send({
        id,
        method: "elicitation/create",
        params: {
          message: "Which name should the e2e test use?",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string", description: "A name" } },
            required: ["name"],
          },
        },
      });
      return;
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "not found" } });
  }
});
