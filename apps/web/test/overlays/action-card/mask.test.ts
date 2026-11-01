import { describe, expect, it } from "vitest";
import { maskSpans } from "../../../src/overlays/action-card/mask.ts";

// M4.07: which parts of an exact tool input the action card hides behind click-to-reveal.
//
// Rule source: the engine redactor (`packages/adapters/src/redact/text.ts`, `redactText`). That
// redactor is pure and has no Node-only imports, so the card can call it and keep its spans, the
// same way `data/domain.ts` re-exports from the shared packages by relative path. What the card
// shows as hidden is therefore exactly what the engine would have masked in the event log: every
// kind it knows (private keys, provider tokens, JWTs, URL passwords, bearer and basic auth,
// sensitive `NAME=value` assignments, high-entropy runs). These tests pin a representative subset
// of those kinds plus the shape of the result; they do not re-test the redactor.
//
// `maskSpans(text)` returns `{ kind, start, end }[]`: UTF-16 offsets into `text`, half-open,
// sorted, never overlapping, and covering the secret value only (not the `Bearer ` or `NAME=`
// in front of it).

const GITHUB = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;

const slice = (text: string) =>
  maskSpans(text).map((s) => ({ kind: s.kind, text: text.slice(s.start, s.end) }));

describe("maskSpans: secret kinds", () => {
  it("finds a GitHub token", () => {
    expect(slice(`export GH=${GITHUB} && echo hi`)).toEqual([
      { kind: "github-token", text: GITHUB },
    ]);
  });

  it("finds an Anthropic key", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwx";
    expect(slice(`ANTHROPIC=${key}`)).toEqual([{ kind: "anthropic-key", text: key }]);
  });

  it("finds an AWS access key id", () => {
    expect(slice("aws --key AKIAIOSFODNN7EXAMPLE x")).toEqual([
      { kind: "aws-access-key", text: "AKIAIOSFODNN7EXAMPLE" },
    ]);
  });

  it("finds Slack and Stripe tokens", () => {
    expect(slice("xoxb-1234567890-abcdefghij")).toEqual([
      { kind: "slack-token", text: "xoxb-1234567890-abcdefghij" },
    ]);
    expect(slice("sk_live_abcdefghijklmnop1234")).toEqual([
      { kind: "stripe-key", text: "sk_live_abcdefghijklmnop1234" },
    ]);
  });

  it("finds a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefSIG";
    expect(slice(`token is ${jwt}`)).toEqual([{ kind: "jwt", text: jwt }]);
  });

  it("covers only the credential after Bearer, not the word Bearer", () => {
    expect(slice('curl -H "Authorization: Bearer abcdefghijklmnop1234" https://x')).toEqual([
      { kind: "bearer-token", text: "abcdefghijklmnop1234" },
    ]);
  });

  it("covers only the password of a URL", () => {
    expect(slice("psql postgres://user:hunter2pass@db.example.com/x")).toEqual([
      { kind: "url-password", text: "hunter2pass" },
    ]);
  });

  it("covers only the value of an assignment to a sensitive name", () => {
    expect(slice("export API_TOKEN=abc123def456")).toEqual([
      { kind: "sensitive-value", text: "abc123def456" },
    ]);
  });

  it("covers a whole private key block as one span", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----";
    expect(slice(`cat > key.pem <<EOF\n${pem}\nEOF`)).toEqual([{ kind: "private-key", text: pem }]);
  });
});

describe("maskSpans: what is not a secret", () => {
  it.each([
    ["an empty string", ""],
    ["a plain command", "git commit -m 'fix' && ls -la /tmp"],
    ["a lookup key that only looks like a key name", 'git commit -m "cacheKey=abc"'],
    ["a git SHA", "git show 3b18e512dba79e4c8300dd08aeb37f8e728b8dad"],
    ["a UUID", "echo 550e8400-e29b-41d4-a716-446655440000"],
    ["a reference to a variable", "echo $API_TOKEN"],
    ["a mask marker the log already holds", "echo [REDACTED:github-token]"],
  ])("finds nothing in %s", (_name, text) => {
    expect(maskSpans(text)).toEqual([]);
  });
});

describe("maskSpans: shape of the result", () => {
  it("returns several spans sorted by start without overlap", () => {
    const text = `A=${GITHUB} then AKIAIOSFODNN7EXAMPLE then xoxb-1234567890-abcdefghij`;
    const spans = maskSpans(text);
    expect(spans.map((s) => s.kind)).toEqual(["github-token", "aws-access-key", "slack-token"]);
    for (let i = 0; i < spans.length; i++) {
      expect(spans[i].start).toBeLessThan(spans[i].end);
      if (i > 0) expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });

  it("is deterministic and does not mutate or depend on earlier calls", () => {
    const text = `x ${GITHUB} y`;
    expect(maskSpans(text)).toEqual(maskSpans(text));
  });

  it("handles a large input in one pass", () => {
    const filler = "echo hello world\n".repeat(2000);
    const text = `${filler}${GITHUB}\n${filler}`;
    const spans = maskSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(GITHUB);
  });
});
