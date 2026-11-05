import { describe, expect, it } from "vitest";
import { cli } from "./helpers.ts";

// M7.10 security review M1: the CLI token is only ever sent to a loopback engine, so --url and
// TASKVILLE_URL must name http://127.0.0.1:<port> or http://localhost:<port>.
describe("engine URL must be loopback", () => {
  it.each([
    "http://evil.example:80",
    "https://127.0.0.1:4807",
    "http://127.0.0.1.evil.example:4807",
    "http://user@127.0.0.1:4807",
  ])("--url %s is refused before any request", async (url) => {
    const r = await cli(["doctor", "--url", url]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/loopback|127\.0\.0\.1/);
  });

  it("TASKVILLE_URL pointing elsewhere is refused", async () => {
    const r = await cli(["status", "--project", "unsorted"], {
      env: { TASKVILLE_URL: "http://evil.example:4807" },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/loopback|127\.0\.0\.1/);
  });
});
