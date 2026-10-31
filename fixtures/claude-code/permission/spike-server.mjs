// Throwaway spike server for S-1. Logs every hook request to JSONL.
// Mode is switched at runtime: GET /_mode?m=<mode>&hold=<seconds>&msg=<text>
// Modes for /permission: allow, deny, empty, hang. Other paths answer 200 {} immediately.

import fs from "node:fs";
import http from "node:http";

const LOG = process.env.LOG || new URL("./log.jsonl", import.meta.url).pathname;
let mode = { m: "empty", hold: 0, msg: "Denied by spike server" };
let seq = 0;
const t0 = Date.now();
const log = (o) => {
  const rec = { ts: new Date().toISOString(), tRel: ((Date.now() - t0) / 1000).toFixed(3), ...o };
  fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
  console.log(JSON.stringify(rec).slice(0, 300));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/_mode") {
      mode = {
        m: url.searchParams.get("m") || "empty",
        hold: Number(url.searchParams.get("hold") || 0),
        msg: url.searchParams.get("msg") || mode.msg,
      };
      log({ kind: "mode", mode });
      res.end(JSON.stringify(mode));
      return;
    }
    const id = ++seq;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        json = body;
      }
      log({
        kind: "request",
        id,
        path: url.pathname,
        method: req.method,
        // Mask credentials before anything reaches the log.
        headers: {
          ...req.headers,
          ...(req.headers.authorization ? { authorization: "<redacted>" } : {}),
        },
        body: json,
        mode: url.pathname === "/permission" ? mode : undefined,
      });
      let answered = false;
      res.on("close", () => {
        if (!answered) log({ kind: "client_closed_before_answer", id, path: url.pathname });
      });
      const answer = (status, payload) => {
        if (res.destroyed) {
          log({ kind: "answer_skipped_socket_gone", id });
          return;
        }
        answered = true;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
        log({ kind: "response", id, path: url.pathname, status, payload });
      };
      if (url.pathname !== "/permission") {
        answer(200, "");
        return;
      }
      const { m, hold, msg } = mode;
      if (m === "hang") return; // never answer
      setTimeout(() => {
        if (m === "allow")
          answer(
            200,
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "allow" },
              },
            }),
          );
        else if (m === "deny")
          answer(
            200,
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "deny", message: msg },
              },
            }),
          );
        else answer(200, "");
      }, hold * 1000);
    });
  })
  .listen(47801, "127.0.0.1", () => log({ kind: "listening", port: 47801 }));
