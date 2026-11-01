import { describe, expect, it } from "vitest";
import { inputText } from "../../../src/overlays/action-card/input.ts";
import { inputMaskSpans, maskSpans } from "../../../src/overlays/action-card/mask.ts";

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

// --- structured inputs: values the JSON redactor seals whole (M4.07 pin round) ----------------
//
// `redactText` reads text; it cannot see that a value sits under a sensitive property name. The
// card therefore asks `inputMaskSpans(toolInput, text)` for a structured input shown as pretty
// JSON: each value `redactJson` seals whole becomes one span over that value as displayed (an
// object, array or number in full, a string without its quotes). Whatever is left once every span
// is cut out of the text must hold no secret, and the offsets must land on the displayed text
// even where JSON escapes (backslash-quote, double backslash, \n, \u0001) make it longer than
// the raw string.

const shown = (toolInput: unknown) => {
  const text = inputText(toolInput);
  return { text, spans: inputMaskSpans(toolInput, text) };
};

/** The text with every masked span cut out: what the card shows before anything is revealed. */
const unrevealed = (toolInput: unknown) => {
  const { text, spans } = shown(toolInput);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += `${text.slice(cursor, span.start)}[MASK]`;
    cursor = span.end;
  }
  return out + text.slice(cursor);
};

/** A value of a top-level property as it is laid out in the card's two-space pretty JSON. */
const prettyAtDepthOne = (value: unknown) => JSON.stringify(value, null, 2).replace(/\n/g, "\n  ");

describe("inputMaskSpans: a value sealed whole under a sensitive key", () => {
  it("masks a nested object, keys inside it included, as one span over the whole object", () => {
    const input = { tool: "deploy", password: { value: "hunter2-secret", hunter3: true } };
    const { text, spans } = shown(input);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(prettyAtDepthOne(input.password));
    const left = unrevealed(input);
    expect(left).not.toContain("hunter2-secret");
    expect(left).not.toContain("hunter3");
    expect(left).toContain('"tool": "deploy"');
    expect(left).toContain('"password": [MASK]');
  });

  it("masks an array under a sensitive key as one span over the whole array", () => {
    const input = { label: "keys", apiToken: ["alpha-secret-one", "beta-secret-two"] };
    const { spans } = shown(input);
    expect(spans).toHaveLength(1);
    const left = unrevealed(input);
    expect(left).not.toContain("alpha-secret-one");
    expect(left).not.toContain("beta-secret-two");
    expect(left).toContain('"label": "keys"');
    expect(left).toContain('"apiToken": [MASK]');
  });

  it("masks a number under a sensitive key", () => {
    const input = { user: "ada", token: 918273645, retries: 3 };
    const { text, spans } = shown(input);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("918273645");
    const left = unrevealed(input);
    expect(left).not.toContain("918273645");
    expect(left).toContain('"retries": 3');
  });

  it("masks a sensitive key deep inside readable structure", () => {
    const input = { steps: [{ run: "build" }, { env: { DB_PASSWORD: { v: "deep-secret-99" } } }] };
    const left = unrevealed(input);
    expect(left).not.toContain("deep-secret-99");
    expect(left).toContain('"run": "build"');
  });
});

describe("inputMaskSpans: a string the JSON redactor seals whole", () => {
  it("masks the value of a name/value pair whose properties are not side by side", () => {
    const input = { name: "DB_PASSWORD", other: true, value: "hunter2" };
    const { text, spans } = shown(input);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("hunter2");
    const left = unrevealed(input);
    expect(left).not.toContain("hunter2");
    expect(left).toContain('"name": "DB_PASSWORD"');
    expect(left).toContain('"other": true');
  });

  it("does not mask the value of a pair whose name is not sensitive", () => {
    const input = { name: "REGION", other: true, value: "eu-west-1" };
    expect(shown(input).spans).toEqual([]);
  });

  it("masks an ordinary string under a sensitive key without its quotes", () => {
    const { text, spans } = shown({ password: "hunter2" });
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("hunter2");
  });
});

describe("inputMaskSpans: offsets stay right when JSON escapes lengthen the text", () => {
  it("lands on a sealed string with quote, backslash, newline and control-character escapes", () => {
    const secret = 'pa"ss\\w\nord\u0001end';
    const input = { name: "DB_PASSWORD", other: true, value: secret };
    const { text, spans } = shown(input);
    expect(text).toContain("\\u0001");
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(JSON.stringify(secret).slice(1, -1));
    const left = unrevealed(input);
    expect(left).not.toContain("ss\\\\w");
    expect(left).not.toContain("u0001");
    expect(left).toContain('"other": true');
  });

  it("lands on a sealed value that follows keys and strings full of escapes", () => {
    const input = {
      'we"ird\\key': 'say "hi"\n\\ done',
      note: "tab\there \u0007",
      password: { inner: 'x"y\\z', n: 1 },
      after: "visible",
    };
    const { text, spans } = shown(input);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(prettyAtDepthOne(input.password));
    const left = unrevealed(input);
    expect(left).not.toContain("inner");
    expect(left).toContain('"after": "visible"');
    expect(left).toContain("tab\\there");
  });

  it("lands a text-pass secret inside an escaped string on the secret alone", () => {
    const bearer = "abcdefghijklmnop1234";
    const input = { log: `said "hi"\n\\ then Authorization: Bearer ${bearer}\nend` };
    const { text, spans } = shown(input);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(bearer);
    expect(unrevealed(input)).not.toContain(bearer);
  });
});

describe("inputMaskSpans: shape and non-secrets", () => {
  it("returns sorted, non-overlapping spans when text and structure both find secrets", () => {
    const input = { password: { v: 1 }, env: `A=${GITHUB}`, token: 5551234 };
    const { spans } = shown(input);
    expect(spans).toHaveLength(3);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
    expect(unrevealed(input)).not.toContain(GITHUB);
  });

  it("finds nothing in a plain structured input or a primitive one", () => {
    expect(shown({ path: "/tmp/x", count: 2, flags: ["-a", "-b"] }).spans).toEqual([]);
    expect(inputMaskSpans(null, "null")).toEqual([]);
    expect(inputMaskSpans(42, "42")).toEqual([]);
  });

  it("falls back to the text pass for a Bash command input", () => {
    const { text, spans } = shown({ command: `export GH=${GITHUB}` });
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([GITHUB]);
  });
});
