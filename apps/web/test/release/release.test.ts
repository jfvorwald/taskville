import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  fetchRelease,
  parseRelease,
  type ReleaseIdentity,
  shortReleaseId,
} from "../../src/release/identity.ts";
import { ReleaseBadge, ReleaseBanner } from "../../src/release/ReleaseBadge.tsx";

// M7.26 (#421). The header shows a quiet badge (environment and short release id) read from
// /health, and a clearly visible STAGING banner only when the environment is "staging".

const staging: ReleaseIdentity = {
  id: "20261106-abc1234",
  version: "1.4.0",
  environment: "staging",
};
const production: ReleaseIdentity = {
  id: "20261106-abc1234",
  version: "1.4.0",
  environment: "production",
};
const dev: ReleaseIdentity = { id: "dev", version: "0.0.0", environment: "development" };

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("parseRelease", () => {
  it("reads the release block of a /health body", () => {
    expect(parseRelease({ status: "ok", release: staging })).toEqual(staging);
  });

  it("accepts a release without a version", () => {
    expect(parseRelease({ release: { id: "dev", environment: "development" } })).toMatchObject({
      id: "dev",
      environment: "development",
    });
  });

  it("returns null for anything else, so an old engine shows no badge", () => {
    for (const body of [null, undefined, "x", 3, {}, { release: null }, { release: { id: 1 } }]) {
      expect(parseRelease(body), String(JSON.stringify(body))).toBeNull();
    }
    expect(parseRelease({ release: { id: "r", environment: "moon" } })).toBeNull();
  });
});

describe("shortReleaseId", () => {
  it("keeps short ids and shortens long ones to a stable prefix", () => {
    expect(shortReleaseId("dev")).toBe("dev");
    const short = shortReleaseId("abcdef0123456789abcdef0123456789abcdef01");
    expect(short.length).toBeLessThanOrEqual(12);
    expect("abcdef0123456789abcdef0123456789abcdef01".startsWith(short)).toBe(true);
  });
});

describe("fetchRelease", () => {
  it("calls /health with the session header and returns the release", async () => {
    const calls: { url: string; headers: unknown }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers });
      return new Response(JSON.stringify({ status: "ok", release: staging }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchRelease(fakeFetch, "secret-1")).toEqual(staging);
    expect(calls[0]?.url).toBe("/health");
    expect(JSON.stringify(calls[0]?.headers)).toContain("secret-1");
  });

  it("returns null on network failure, a non-ok status or a bad body", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const status = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    const junk = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchRelease(boom, "s")).toBeNull();
    expect(await fetchRelease(status, "s")).toBeNull();
    expect(await fetchRelease(junk, "s")).toBeNull();
  });
});

describe("ReleaseBadge", () => {
  it("shows the environment and the short release id", () => {
    const out = html(createElement(ReleaseBadge, { release: production }));
    expect(out).toContain("production");
    expect(out).toContain(shortReleaseId(production.id));
  });

  it("renders the dev fallback too", () => {
    const out = html(createElement(ReleaseBadge, { release: dev }));
    expect(out).toContain("development");
    expect(out).toContain("dev");
  });

  it("renders nothing without a release", () => {
    expect(html(createElement(ReleaseBadge, { release: null }))).toBe("");
  });
});

describe("ReleaseBanner", () => {
  it("shows a STAGING banner when the environment is staging", () => {
    expect(html(createElement(ReleaseBanner, { release: staging }))).toContain("STAGING");
  });

  it("is absent for production, development and no release", () => {
    for (const release of [production, dev, null]) {
      expect(html(createElement(ReleaseBanner, { release })), String(release?.environment)).toBe(
        "",
      );
    }
  });

  it("does not put STAGING in the quiet badge for production", () => {
    expect(html(createElement(ReleaseBadge, { release: production }))).not.toContain("STAGING");
  });
});
