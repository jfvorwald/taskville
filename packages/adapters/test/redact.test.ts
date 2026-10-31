import { describe, expect, it } from "vitest";
import {
  type JsonValue,
  type MaskKind,
  maskMarker,
  type RedactedText,
  redactJson,
  redactText,
} from "../src/redact/index.ts";

// Every fake secret here is assembled at runtime from short parts and a seeded
// generator, so no token-shaped literal appears in the source and secret scanners
// (GitHub push protection, roborev) have nothing to match. None of them is real.

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B64 = `${B62}+/`;

function chars(n: number, alphabet: string, seed: number): string {
  const next = seeded(seed);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[next() % alphabet.length];
  return out;
}

const body = (n: number, seed = 1) => chars(n, B62, seed);

const fake = {
  anthropic: ["sk", "-ant-", "api03-", body(93, 2), "AA"].join(""),
  openaiProject: ["sk", "-proj-", body(48, 3)].join(""),
  openaiLegacy: ["sk", "-", body(48, 4)].join(""),
  githubClassic: ["gh", "p_", body(36, 5)].join(""),
  githubOauth: ["gh", "o_", body(36, 6)].join(""),
  githubFineGrained: ["github", "_pat_", body(22, 7), "_", body(59, 8)].join(""),
  aws: ["AK", "IA", chars(16, UPPER_DIGITS, 9)].join(""),
  slackBot: ["xo", "xb-", "1234567890", "12-", "9876543210", "123-", body(24, 10)].join(""),
  stripeLive: ["sk", "_live_", body(24, 11)].join(""),
  stripeRestricted: ["rk", "_test_", body(24, 12)].join(""),
  jwt: [
    "ey",
    "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    ".",
    "ey",
    "JzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjB9",
    ".",
    body(43, 13),
  ].join(""),
  bearer: body(40, 14),
  basic: `${chars(30, B64, 20)}==`,
  pemBody: chars(64, B64, 15),
  generic40: body(40, 16),
  generic32: body(32, 17),
  slashed: [body(12, 22), "/", body(14, 23), "/", body(12, 24)].join(""),
  slashedWord: [body(16, 27), "/abc/", body(19, 28)].join(""),
  // A 32-character hex credential, as in the M1.18 F3 finding: hex-only, so the
  // high-entropy rule never sees it.
  hexToken: ["5f4d", chars(28, "0123456789abcdef", 29)].join(""),
  shortToken: [chars(11, B62, 30), "7"].join(""),
  password: ["s3", "cr3t", "pa", "ss"].join(""),
  lettersToken: chars(16, "abcdefghijklmnopqrstuvwxyz", 31),
  hexResponse: chars(32, "0123456789abcdef", 32),
  hexSignature: chars(64, "0123456789abcdef", 33),
};

const pem = (label: string) =>
  [
    `-----BEGIN ${label}`,
    "PRIVATE KEY-----\n",
    `${fake.pemBody}\n${fake.pemBody}\n`,
    `-----END ${label}`,
    "PRIVATE KEY-----",
  ].join("");

/** Rebuilds the masked text from the original input and the spans alone. */
function rebuild(input: string, result: RedactedText): string {
  let out = "";
  let at = 0;
  for (const span of result.spans) {
    out += input.slice(at, span.start) + maskMarker(span.kind);
    at = span.end;
  }
  return out + input.slice(at);
}

function expectWellFormed(input: string, result: RedactedText): void {
  let prevEnd = 0;
  let prevMaskedEnd = 0;
  for (const span of result.spans) {
    expect(span.start).toBeGreaterThanOrEqual(prevEnd);
    expect(span.end).toBeGreaterThan(span.start);
    expect(span.maskedStart).toBeGreaterThanOrEqual(prevMaskedEnd);
    expect(result.text.slice(span.maskedStart, span.maskedEnd)).toBe(maskMarker(span.kind));
    prevEnd = span.end;
    prevMaskedEnd = span.maskedEnd;
  }
  expect(rebuild(input, result)).toBe(result.text);
}

interface Positive {
  name: string;
  input: string;
  secret: string;
  kind: MaskKind;
}

const positives: Positive[] = [
  {
    name: "Anthropic API key in prose",
    input: `my key is ${fake.anthropic} ok`,
    secret: fake.anthropic,
    kind: "anthropic-key",
  },
  {
    name: "OpenAI project key",
    input: `using ${fake.openaiProject}`,
    secret: fake.openaiProject,
    kind: "openai-key",
  },
  {
    name: "OpenAI legacy key",
    input: `(${fake.openaiLegacy})`,
    secret: fake.openaiLegacy,
    kind: "openai-key",
  },
  {
    name: "GitHub classic token in a command",
    input: `gh auth login --with-token ${fake.githubClassic}`,
    secret: fake.githubClassic,
    kind: "github-token",
  },
  {
    name: "GitHub OAuth token",
    input: `token ${fake.githubOauth}.`,
    secret: fake.githubOauth,
    kind: "github-token",
  },
  {
    name: "GitHub fine-grained token",
    input: `pat: ${fake.githubFineGrained}`,
    secret: fake.githubFineGrained,
    kind: "github-token",
  },
  {
    name: "AWS access key id",
    input: `aws configure set aws_access_key_id ${fake.aws}`,
    secret: fake.aws,
    kind: "aws-access-key",
  },
  {
    name: "Slack bot token",
    input: `curl -d token=${fake.slackBot} https://slack.example`,
    secret: fake.slackBot,
    kind: "slack-token",
  },
  {
    name: "Stripe live secret key",
    input: `stripe.key(${fake.stripeLive})`,
    secret: fake.stripeLive,
    kind: "stripe-key",
  },
  {
    name: "Stripe restricted test key",
    input: `${fake.stripeRestricted}`,
    secret: fake.stripeRestricted,
    kind: "stripe-key",
  },
  {
    name: "JWT",
    input: `cookie session=${fake.jwt}; Path=/`,
    secret: fake.jwt,
    kind: "jwt",
  },
  {
    name: "bearer token in a header",
    input: `curl -H "Authorization: Bearer ${fake.bearer}" https://api.example`,
    secret: fake.bearer,
    kind: "bearer-token",
  },
  {
    name: "basic auth header",
    input: `curl -H 'Authorization: Basic ${fake.basic}' https://api.example`,
    secret: fake.basic,
    kind: "basic-auth",
  },
  {
    name: "RSA private key block",
    input: `here:\n${pem("RSA ")}\nthanks`,
    secret: pem("RSA "),
    kind: "private-key",
  },
  {
    name: "OpenSSH private key block",
    input: pem("OPENSSH "),
    secret: pem("OPENSSH "),
    kind: "private-key",
  },
  {
    name: "unterminated private key block masks to the end",
    input: `key: ${pem("").slice(0, 60)}`,
    secret: pem("").slice(0, 60),
    kind: "private-key",
  },
  {
    name: "sensitive env var, shell form",
    input: "GITHUB_TOKEN=hunter2abc npm publish",
    secret: "hunter2abc",
    kind: "sensitive-value",
  },
  {
    name: "sensitive env var, exported and quoted with a space",
    input: "export DB_PASSWORD='p@ss word'; psql",
    secret: "p@ss word",
    kind: "sensitive-value",
  },
  {
    name: "sensitive env var, double quoted",
    input: 'API_KEY="abc123"',
    secret: "abc123",
    kind: "sensitive-value",
  },
  {
    name: "secret env var with lowercase-only value",
    input: "CLIENT_SECRET=correcthorsebattery",
    secret: "correcthorsebattery",
    kind: "sensitive-value",
  },
  {
    name: "password flag with equals",
    input: "mysql --password=hunter2 -u app",
    secret: "hunter2",
    kind: "sensitive-value",
  },
  {
    name: "token flag with a space",
    input: "deploy --api-token s3cr3tvalue --yes",
    secret: "s3cr3tvalue",
    kind: "sensitive-value",
  },
  {
    name: "JSON text with a camelCase secret key",
    input: '{"clientSecret":"abc123xyz","name":"app"}',
    secret: "abc123xyz",
    kind: "sensitive-value",
  },
  {
    name: "JSON text with a plain secret key",
    input: '{ "secret": "letmein" }',
    secret: "letmein",
    kind: "sensitive-value",
  },
  {
    name: "YAML password",
    input: "db:\n  password: hunter2\n  host: localhost",
    secret: "hunter2",
    kind: "sensitive-value",
  },
  {
    name: "sensitive value that starts with a dollar sign",
    input: "PASSWORD=$ecret123 ./start",
    secret: "$ecret123",
    kind: "sensitive-value",
  },
  {
    name: "standalone high-entropy token in prose",
    input: `the reason: retry with ${fake.generic40} please`,
    secret: fake.generic40,
    kind: "high-entropy",
  },
  {
    name: "standalone base64 secret containing slashes",
    input: `rotated to ${fake.slashed} yesterday`,
    secret: fake.slashed,
    kind: "high-entropy",
  },
  {
    name: "sensitive value that starts with a mask marker",
    input: "PASSWORD=[REDACTED:sensitive-value]hunter2 ./start",
    secret: "[REDACTED:sensitive-value]hunter2",
    kind: "sensitive-value",
  },
  {
    name: "sensitive value with text after a command substitution",
    input: "PASSWORD=$(cat x)hunter2 ./start",
    secret: "$(cat x)hunter2",
    kind: "sensitive-value",
  },
  {
    name: "sensitive value that is an unclosed brace",
    input: ["PASSWORD='$", "{hunter2'"].join(""),
    secret: ["$", "{hunter2"].join(""),
    kind: "sensitive-value",
  },
  {
    name: "sensitive shell value containing a bracket",
    input: "PASSWORD=abc]def)ghi ./start",
    secret: "abc]def)ghi",
    kind: "sensitive-value",
  },
  {
    name: "sensitive value in a JavaScript object literal",
    input: "connect({ password: hunter2 })",
    secret: "hunter2",
    kind: "sensitive-value",
  },
  {
    name: "sensitive value followed by another object property",
    input: "connect({password: hunter2,port:5432})",
    secret: "hunter2",
    kind: "sensitive-value",
  },
  {
    name: "standalone token after an underscored segment and a slash",
    input: `see abc_def/${fake.generic32} now`,
    secret: `abc_def/${fake.generic32}`,
    kind: "high-entropy",
  },
  {
    name: "upper-case basic auth header",
    input: `AUTHORIZATION: BASIC ${fake.basic}`,
    secret: fake.basic,
    kind: "basic-auth",
  },
  {
    name: "lower-case bearer scheme",
    input: `authorization: bearer ${fake.bearer}`,
    secret: fake.bearer,
    kind: "bearer-token",
  },
  {
    name: "standalone base64 secret with a lowercase segment",
    input: `rotated to ${fake.slashedWord} yesterday`,
    secret: fake.slashedWord,
    kind: "high-entropy",
  },
  {
    name: "query parameter",
    input: "GET https://example.test/cb?access_token=abc123def456&state=1",
    secret: "abc123def456",
    kind: "sensitive-value",
  },
  {
    name: "password in a connection URL",
    input: "DATABASE_URL=postgres://app:s3cretpw@db.local:5432/main",
    secret: "s3cretpw",
    kind: "url-password",
  },
  {
    name: "high-entropy value under an ordinary name, shell form",
    input: `SOMETHING=${fake.generic40} ./run`,
    secret: fake.generic40,
    kind: "high-entropy",
  },
  {
    name: "high-entropy value under an ordinary name, quoted",
    input: `config_value = "${fake.generic32}"`,
    secret: fake.generic32,
    kind: "high-entropy",
  },
  {
    name: "secret after multi-byte text",
    input: `🚀 déploiement ${fake.githubClassic} ✅`,
    secret: fake.githubClassic,
    kind: "github-token",
  },
  {
    name: "sensitive value containing multi-byte characters",
    input: "PASSWORD=pässwörd🔑x next",
    secret: "pässwörd🔑x",
    kind: "sensitive-value",
  },
  // M1.18 F3 (a): Authorization schemes other than Bearer and Basic.
  {
    name: "Token scheme in a curl Authorization header",
    input: `curl -H "Authorization: Token ${fake.hexToken}" https://api.example`,
    secret: fake.hexToken,
    kind: "bearer-token",
  },
  {
    name: "lower-case token scheme in single quotes",
    input: `curl -H 'authorization: token ${fake.hexToken}' https://api.example`,
    secret: fake.hexToken,
    kind: "bearer-token",
  },
  {
    name: "short alphanumeric credential under a scheme",
    input: `Authorization: ApiKey ${fake.shortToken}`,
    secret: fake.shortToken,
    kind: "bearer-token",
  },
  {
    name: "Proxy-Authorization with a Negotiate scheme",
    input: `Proxy-Authorization: Negotiate ${fake.generic40}`,
    secret: fake.generic40,
    kind: "bearer-token",
  },
  {
    name: "Authorization assignment with a scheme",
    input: `authorization = Token ${fake.hexToken}`,
    secret: fake.hexToken,
    kind: "bearer-token",
  },
  {
    name: "lower-case letters-only credential under a known scheme",
    input: `curl -H "Authorization: Token ${fake.lettersToken}" https://x`,
    secret: fake.lettersToken,
    kind: "bearer-token",
  },
  {
    name: "short lower-case Bearer credential",
    input: "Authorization: Bearer abcdefghij",
    secret: "abcdefghij",
    kind: "bearer-token",
  },
  {
    name: "Digest parameters in a raw header",
    input: `Authorization: Digest username="admin", response="${fake.hexResponse}"\nHost: x`,
    secret: `username="admin", response="${fake.hexResponse}"`,
    kind: "bearer-token",
  },
  {
    name: "Digest parameters with shell-escaped quotes",
    input: `curl -H "Authorization: Digest username=\\"admin\\", response=\\"${fake.hexResponse}\\"" https://x`,
    // The whole rest of the line is masked, trailing URL included.
    secret: `username=\\"admin\\", response=\\"${fake.hexResponse}\\"" https://x`,
    kind: "bearer-token",
  },
  {
    name: "Digest parameters with an escaped quote in a value",
    input: `Authorization: Digest username="ad\\"min", response="${fake.hexResponse}"`,
    secret: `username="ad\\"min", response="${fake.hexResponse}"`,
    kind: "bearer-token",
  },
  {
    name: "Digest parameters with spaces around the equals signs",
    input: `Authorization: Digest username = "admin", response = "${fake.hexResponse}"`,
    secret: `username = "admin", response = "${fake.hexResponse}"`,
    kind: "bearer-token",
  },
  {
    name: "Digest parameters after a very long uri",
    input: `Authorization: Digest uri="/${"a".repeat(5000)}", response="${fake.hexResponse}"`,
    secret: `uri="/${"a".repeat(5000)}", response="${fake.hexResponse}"`,
    kind: "bearer-token",
  },
  {
    name: "Basic credential with one pad is not read as a parameter list",
    input: `curl -H "Authorization: Basic ${fake.basic.slice(0, 31)}=" https://x`,
    secret: `${fake.basic.slice(0, 31)}=`,
    kind: "basic-auth",
  },
  {
    name: "Digest parameters with an empty first value",
    input: `Authorization: Digest username="", response="${fake.hexResponse}"`,
    secret: `username="", response="${fake.hexResponse}"`,
    kind: "bearer-token",
  },
  {
    name: "Digest parameters with a space-led first value",
    input: `Authorization: Digest username=" admin", response="${fake.hexResponse}"`,
    secret: `username=" admin", response="${fake.hexResponse}"`,
    kind: "bearer-token",
  },
  {
    name: "Digest parameters with a space-led first value holding an escaped quote",
    input: `Authorization: Digest username=" a\\"b", response="${fake.hexResponse}"`,
    secret: `username=" a\\"b", response="${fake.hexResponse}"`,
    kind: "bearer-token",
  },
  {
    name: "shell-escaped Digest parameters with a space-led first value",
    input: `curl -H "Authorization: Digest username=\\" a\\", response=\\"${fake.hexResponse}\\""`,
    secret: `username=\\" a\\", response=\\"${fake.hexResponse}\\""`,
    kind: "bearer-token",
  },
  {
    name: "AWS SigV4 parameters",
    input: `Authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=host;x-amz-date, Signature=${fake.hexSignature}`,
    secret: `Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=host;x-amz-date, Signature=${fake.hexSignature}`,
    kind: "bearer-token",
  },
  // M1.18 F3 (b): curl user credentials. Only the password is masked.
  {
    name: "curl -u user:password",
    input: `curl -u admin:${fake.password} https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl --user user:password",
    input: `curl --user admin:${fake.password} https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl --user=user:password",
    input: `curl --user=admin:${fake.password} https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl -u with the value attached",
    input: `curl -uadmin:${fake.password} https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl -u with an email user and an API token, quoted",
    input: `curl -u 'me@example.com:${fake.hexToken}' https://x`,
    secret: fake.hexToken,
    kind: "basic-auth",
  },
  {
    name: "curl --user with a quoted password containing a space",
    input: `curl --user "admin:${fake.password} two" https://x`,
    secret: `${fake.password} two`,
    kind: "basic-auth",
  },
  {
    name: "curl password starting with a slash",
    input: `curl -u admin:/${fake.password} https://x`,
    secret: `/${fake.password}`,
    kind: "basic-auth",
  },
  {
    name: "curl password starting with a tilde",
    input: `curl -u admin:~${fake.password} https://x`,
    secret: `~${fake.password}`,
    kind: "basic-auth",
  },
  {
    name: "curl password after a quoted user",
    input: `curl -u "$API_USER":${fake.password} https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl password after a quoted user segment and a suffix",
    input: `curl -u "$API_USER"suffix:${fake.password} https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl password with a quoted segment inside it",
    input: `curl -u admin:pre"${fake.password}" https://x`,
    secret: `pre"${fake.password}"`,
    kind: "basic-auth",
  },
  {
    name: "curl credentials inside a command substitution used as a user",
    input: `curl -u $(curl -u admin:${fake.password} https://users.example) https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl quoted user and quoted password",
    input: `curl -u 'admin':'${fake.password}' https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl numeric user and numeric password",
    input: "curl -u 1000:123456 https://x",
    secret: "123456",
    kind: "basic-auth",
  },
  {
    name: "curl --proxy-user",
    input: `curl --proxy-user proxy:${fake.password} -x http://p:3128 https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  {
    name: "curl -U proxy credentials",
    input: `curl -U proxy:${fake.password} https://x`,
    secret: fake.password,
    kind: "basic-auth",
  },
  // M2.22 (#211, M2.11 F2): common credential names and password flags.
  ...[
    ["PGPASSWORD", "psql -h db app"],
    ["MYSQL_PWD", "mysql -u root app"],
    ["DB_PASS", "./migrate"],
    ["SMTP_PASS", "./send-mail"],
    ["REDIS_PASS", "redis-cli ping"],
    ["SECRET_KEY_BASE", "rails server"],
    ["dbPass", "node app.js"],
  ].map(([name, rest]): Positive => {
    return {
      name: `${name} environment assignment`,
      input: `${name}=${fake.password} ${rest}`,
      secret: fake.password,
      kind: "sensitive-value",
    };
  }),
  {
    name: "a flag named db-pass",
    input: `app --db-pass ${fake.password} --port 5432`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "a quoted SECRET_KEY_BASE in a .env line",
    input: `SECRET_KEY_BASE="${fake.password}"`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "mysql -p attached",
    input: `mysql -u root -p${fake.password} app`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "mysql -p attached before the other flags",
    input: `mysql -p${fake.password} -h db -u root app`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "mysql -p attached after the database name",
    input: `mysql app -p${fake.password}`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "mysql -p attached and double quoted",
    input: `mysql -u root -p"${fake.password}" app`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "mysqldump -p attached",
    input: `mysqldump -u root -p${fake.password} app > dump.sql`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "mysql by absolute path",
    input: `/usr/local/bin/mysql -h db -u root -p${fake.password}`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "mysql in the second command of a line",
    input: `cd /srv && mysql -u root -p${fake.password} app`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "sshpass -p with a space",
    input: `sshpass -p ${fake.password} ssh host uptime`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "sshpass -p attached",
    input: `sshpass -p${fake.password} ssh host uptime`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "sshpass -p single quoted",
    input: `sshpass -p '${fake.password}' ssh host uptime`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "sshpass -p after another option",
    input: `sshpass -P assword -p ${fake.password} ssh host`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "docker login -p",
    input: `docker login -p ${fake.password} registry.example.test`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "docker login -u and -p",
    input: `docker login -u me -p ${fake.password} registry.example.test`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "docker login -p attached",
    input: `docker login registry.example.test -p${fake.password}`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "podman login -p",
    input: `podman login -p ${fake.password} registry.example.test`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "JSON name and value pair in a command",
    input: `kubectl patch -p '{"name": "DB_PASSWORD", "value": "${fake.password}"}'`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "compact JSON name and value pair",
    input: `{"name":"MYSQL_PWD","value":"${fake.password}"}`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "JSON key and Value pair with capitals",
    input: `{"Key":"API_SECRET","Value":"${fake.password}"}`,
    secret: fake.password,
    kind: "sensitive-value",
  },
  {
    name: "JSON name and numeric value pair",
    input: '{"name":"DB_PASS","value":123456789}',
    secret: "123456789",
    kind: "sensitive-value",
  },
];

describe("redactText true positives", () => {
  it.each(positives)("$name", ({ input, secret, kind }) => {
    const result = redactText(input);
    expect(result.text).not.toContain(secret);
    const span = result.spans.find((s) => input.slice(s.start, s.end) === secret);
    expect(span, `no span covering exactly the secret in ${JSON.stringify(result)}`).toBeDefined();
    expect(span?.kind).toBe(kind);
    expectWellFormed(input, result);
  });

  it("masks a curl password equal to the user name, keeping the user", () => {
    const input = "curl -u admin:admin http://localhost:8080";
    const result = redactText(input);
    expect(result.text).toBe(`curl -u admin:${maskMarker("basic-auth")} http://localhost:8080`);
    expectWellFormed(input, result);
  });

  it("spans are UTF-16 code unit offsets", () => {
    const input = `🚀 ${fake.githubClassic}`;
    const [span] = redactText(input).spans;
    // The rocket is one code point but two UTF-16 code units; then a space.
    expect(span?.start).toBe(3);
    expect(span?.end).toBe(3 + fake.githubClassic.length);
  });

  it("masks several secrets in one string, in order", () => {
    const input = `a=${fake.githubClassic} b ${fake.aws} TOKEN=xyz12345`;
    const result = redactText(input);
    expect(result.spans.map((s) => s.kind)).toEqual([
      "github-token",
      "aws-access-key",
      "sensitive-value",
    ]);
    expectWellFormed(input, result);
  });

  it("merges overlapping detections into one span", () => {
    const input = `GITHUB_TOKEN=${fake.githubClassic}`;
    const result = redactText(input);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.kind).toBe("github-token");
    expect(result.text).toBe(`GITHUB_TOKEN=${maskMarker("github-token")}`);
  });

  it("merges a token inside a quoted sensitive value into the whole value", () => {
    const input = `PASSWORD="prefix ${fake.githubClassic} suffix"`;
    const result = redactText(input);
    expect(result.spans).toHaveLength(1);
    expect(input.slice(result.spans[0]?.start, result.spans[0]?.end)).toBe(
      `prefix ${fake.githubClassic} suffix`,
    );
    expectWellFormed(input, result);
  });

  it("is idempotent: masked output has nothing left to mask", () => {
    for (const { input } of positives) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.spans, input).toEqual([]);
      expect(twice.text).toBe(once.text);
    }
  });

  it("is deterministic", () => {
    const input = positives.map((p) => p.input).join("\n");
    expect(redactText(input)).toEqual(redactText(input));
  });
});

const sha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";
const uuid = "123e4567-e89b-12d3-a456-426614174000";
const png = [
  "iVBORw0KGgo",
  "AAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4",
  chars(400, B64, 18),
].join("");

const negatives: Array<{ name: string; input: string }> = [
  { name: "empty string", input: "" },
  {
    name: "ordinary prose about secrets",
    input:
      "Use a Bearer token in the Authorization header. Set the password in your keychain. The secret is to keep it simple.",
  },
  {
    name: "prose with a colon after a sensitive word",
    input: "Password: required. Token: see the docs.",
  },
  { name: "git SHA in prose", input: `commit ${sha} fixed it` },
  { name: "git SHA assigned", input: `sha=${sha}` },
  { name: "git SHA quoted under an ordinary name", input: `"head": "${sha}"` },
  {
    name: "lockfile integrity digest",
    input: `"integrity": "sha512-${chars(86, B64, 21)}=="`,
  },
  { name: "short SHA", input: "merged in 08c5c83" },
  { name: "UUID assigned", input: `id=${uuid}` },
  { name: "UUID in JSON text", input: `{"requestId":"${uuid}"}` },
  { name: "base64 PNG data URI", input: `<img src="data:image/png;base64,${png}">` },
  { name: "base64 PNG in JSON text", input: `{"image": "${png}"}` },
  { name: "base64 PNG assigned", input: `thumbnail=${png}` },
  {
    name: "POSIX file path",
    input: "/Users/example/dev/taskville/packages/adapters/src/redact/index.ts",
  },
  { name: "Windows file path", input: "C:\\Users\\example\\AppData\\Local\\taskville\\events.db" },
  { name: "key file path variable", input: "KEY_FILE=/etc/ssl/private/server.key" },
  { name: "token file path variable", input: "TOKEN_PATH=~/.config/taskville/token" },
  { name: "code reading an env var", input: "const apiKey = process.env.API_KEY;" },
  { name: "code calling a function", input: "const token = await getToken();" },
  { name: "code comparing a password", input: 'if (password === "") return;' },
  { name: "code with a member expression", input: "password = req.body.password" },
  { name: "max tokens setting", input: '{"max_tokens": 4096, "model": "claude"}' },
  { name: "shell variable reference", input: "GITHUB_TOKEN=$GITHUB_TOKEN gh pr list" },
  {
    name: "CI secret reference",
    input: ["GITHUB_TOKEN: $", "{{ secrets.GITHUB_TOKEN }}"].join(""),
  },
  { name: "empty sensitive value", input: "PASSWORD= ./start" },
  { name: "braced shell reference", input: ["API_TOKEN=$", "{API_TOKEN:-} make"].join("") },
  { name: "command substitution", input: "PASSWORD=$(cat ~/.pw) ./start" },
  { name: "build asset path with a hash", input: "loaded assets/index-B3kd8Fj2xQ.js" },
  { name: "rooted asset path with a hash", input: "GET /assets/index-B3kd8Fj2xQ.js 200" },
  { name: "nanoid-free prose with long words", input: "internationalization and characterization" },
  {
    name: "Claude Code tool and message IDs in prose",
    input: `call ${["tool", "u_", body(24, 25)].join("")} in ${["ms", "g_", body(24, 26)].join("")}`,
  },
  { name: "already-masked placeholder", input: "API_KEY=******** " },
  { name: "hyphenated words containing sk-", input: "task-runner-configuration-loader-module-v2" },
  { name: "camelCase identifier quoted", input: 'handler = "handleSubmitButtonClick1"' },
  { name: "camelCase identifier with digits", input: "name=processEnvApiKeyValue123" },
  { name: "lookup key that is just 'key'", input: '{"key": "src/redact/index.ts"}' },
  { name: "URL without credentials", input: "https://example.test:8443/path?q=1&page=2" },
  { name: "URL with user but no password", input: "ssh://git@github.com/jfvorwald/taskville.git" },
  { name: "semver and dates", input: "v1.2.3 released 2026-10-30T12:00:00Z" },
  // M1.18 F3: Authorization prose and placeholders.
  { name: "Authorization prose with one word", input: "Authorization: required" },
  {
    name: "Authorization prose with several words",
    input: "Authorization: handled internally by the gateway",
  },
  {
    name: "prose naming the Token scheme",
    input: "The Authorization: Token scheme is described in the docs.",
  },
  {
    name: "Authorization scheme with a starred placeholder",
    input: "Authorization: Token ********",
  },
  {
    name: "Authorization scheme with a variable",
    input: 'curl -H "Authorization: Token $API_TOKEN" https://x',
  },
  {
    name: "Authorization scheme with an angle placeholder",
    input: 'curl -H "Authorization: Token <your-token>" https://x',
  },
  // M1.18 F3: -u and --user in other meanings.
  { name: "sort -u", input: "sort -u names.txt > unique.txt" },
  { name: "git add -u", input: "git add -u && git commit" },
  { name: "git push -u", input: "git push -u origin main" },
  { name: "python -u", input: "python -u -m pytest tests" },
  { name: "sudo -u", input: "sudo -u postgres psql" },
  {
    name: "--user with no colon",
    input: "pip install --user requests; docker run --user root alpine",
  },
  { name: "docker uid:gid from id", input: 'docker run -u "$(id -u):$(id -g)" alpine id' },
  {
    name: "docker uid:gid from id unquoted",
    input: "docker run --user $(id -u):$(id -g) alpine id",
  },
  { name: "curl user with an empty password", input: "curl -u admin: https://x" },
  {
    name: "curl user and password from variables",
    input: 'curl -u "$API_USER:$API_TOKEN" https://x',
  },
  { name: "curl user-agent flag", input: 'curl --user-agent "agent:1" https://x' },
  // M2.22 (#211): -p is a port or publish flag in most tools; only the named commands
  // read it as a password, and only with a real value.
  { name: "ssh -p port", input: "ssh -p 2222 host" },
  { name: "scp -P port", input: "scp -P 2222 a.txt host:/tmp" },
  { name: "docker run -p publish", input: "docker run -p 8080:80 nginx" },
  {
    name: "docker run -p after login in the same line",
    input: "docker login reg; docker run -p 8080:80 nginx",
  },
  { name: "psql -p port", input: "psql -h db -p 5432 -U app" },
  { name: "pg_dump -p port", input: "pg_dump -p 5432 app" },
  { name: "mysql -p alone prompts", input: "mysql -u root -p app" },
  { name: "mysql -p at the end prompts", input: "mysql -u root -p" },
  { name: "mysql -P port", input: "mysql -h db -P 3306 -u root app" },
  { name: "mysql with a password reference", input: 'mysql -u root -p"$DB_PASS" app' },
  { name: "mysql with an unquoted password reference", input: "mysql -u root -p$DB_PASS app" },
  { name: "mysql with a masked password", input: "mysql -u root -p[REDACTED:sensitive-value] app" },
  { name: "mysql -p in a later command", input: "mysql -e 'select 1' && ssh -p 2222 host" },
  { name: "mysql_secure_installation is not mysql", input: "mysql_secure_installation -pfoo" },
  { name: "mysqld is not mysqldump", input: "mysqld -p3306" },
  { name: "sshpass with a password from a file", input: "sshpass -f /run/pw ssh host" },
  { name: "sshpass with the environment", input: "sshpass -e ssh -p 2222 host" },
  { name: "sshpass with a password reference", input: 'sshpass -p "$SSH_PW" ssh -p 2222 host' },
  { name: "sshpass then ssh with a port", input: "sshpass -f /run/pw ssh -p 2222 host" },
  { name: "docker login without a password flag", input: "docker login registry.example.test" },
  { name: "docker login with a reference", input: 'docker login -u me -p "$REGISTRY_TOKEN" reg' },
  { name: "docker login password from stdin", input: "docker login -u me --password-stdin reg" },
  { name: "docker -p without login", input: "docker ps -p 3306" },
  { name: "PWD is the working directory", input: "PWD=/home/me/project make" },
  { name: "OLDPWD is the previous directory", input: "OLDPWD=/home/me/project make" },
  { name: "lower case pwd variable is not a password", input: "pwd=/home/me/project" },
  { name: "bare pass counter", input: 'summary pass=12 fail=0 {"pass": 12}' },
  { name: "bypass is not pass", input: "bypass=ENABLED_FOR_TESTS_1" },
  { name: "SECRET_KEY_BASE reference", input: "SECRET_KEY_BASE=$SECRET_KEY_BASE rails s" },
  { name: "JSON name and value pair for PATH", input: '{"name":"PATH","value":"/usr/bin"}' },
  {
    name: "JSON name pair with a reference",
    input: '{"name":"DB_PASSWORD","value":"$DB_PASSWORD"}',
  },
  { name: "JSON key alone", input: '{"name": "DB_PASSWORD", "description": "the database login"}' },
];

describe("redactText false positives", () => {
  it.each(negatives)("$name", ({ input }) => {
    const result = redactText(input);
    expect(result.spans).toEqual([]);
    expect(result.text).toBe(input);
  });
});

// M2.14 (#185): a token glued to an identifier by `_` (an MCP tool name such as
// `mcp__<server>__<token>`, an env-style name such as `MY_TOKEN_<token>`) is still a token.
// The token lookbehinds excluded `_`. A random token was still caught by the high-entropy
// rule over the whole word, but not one with a low-entropy body, nor one in a word longer than
// the 256 characters that rule looks at.
describe("tokens after an underscore (M2.14)", () => {
  const lowEntropy = (n: number) => "a1B2".repeat(Math.ceil(n / 4)).slice(0, n);
  const tokens: Array<[string, string, string, MaskKind]> = [
    ["GitHub classic", fake.githubClassic, ["gh", "p_", lowEntropy(36)].join(""), "github-token"],
    ["GitHub OAuth", fake.githubOauth, ["gh", "o_", lowEntropy(36)].join(""), "github-token"],
    [
      "GitHub fine-grained",
      fake.githubFineGrained,
      ["github", "_pat_", lowEntropy(24)].join(""),
      "github-token",
    ],
    [
      "Anthropic",
      fake.anthropic,
      ["sk", "-ant-", "api03-", lowEntropy(24)].join(""),
      "anthropic-key",
    ],
    ["OpenAI project", fake.openaiProject, ["sk", "-proj-", lowEntropy(24)].join(""), "openai-key"],
    ["OpenAI legacy", fake.openaiLegacy, ["sk", "-", lowEntropy(24)].join(""), "openai-key"],
    ["Stripe live", fake.stripeLive, ["sk", "_live_", lowEntropy(20)].join(""), "stripe-key"],
    [
      "Stripe restricted",
      fake.stripeRestricted,
      ["rk", "_test_", lowEntropy(20)].join(""),
      "stripe-key",
    ],
  ];
  const prefixes = [
    "_",
    ["mcp", "__", "github", "__"].join(""),
    ["MY", "_TOKEN_"].join(""),
    "a_b_",
  ];
  const longPrefix = "ab_".repeat(100);

  // The token rule alone: nothing else masks these, so the prefix stays and the kind is exact.
  it.each(
    tokens.flatMap(([name, , low, kind]) =>
      prefixes.map((prefix) => ({
        name: `${name} (low entropy) after "${prefix}"`,
        prefix,
        low,
        kind,
      })),
    ),
  )("masks $name, keeping the prefix", ({ prefix, low, kind }) => {
    const input = `run ${prefix}${low} now`;
    const result = redactText(input);
    expect(result.text).toBe(`run ${prefix}${maskMarker(kind)} now`);
    expectWellFormed(input, result);
  });

  it.each(tokens.map(([name, random, , kind]) => ({ name, random, kind })))(
    "masks a random $name at the end of a word longer than 256 characters",
    ({ random, kind }) => {
      const input = `run ${longPrefix}${random} now`;
      const result = redactText(input);
      expect(result.text).toBe(`run ${longPrefix}${maskMarker(kind)} now`);
      expectWellFormed(input, result);
    },
  );

  it.each(
    tokens.flatMap(([name, random]) =>
      prefixes.map((prefix) => ({ name: `${name} after "${prefix}"`, prefix, random })),
    ),
  )("still masks a random $name in full", ({ prefix, random }) => {
    const input = `run ${prefix}${random} now`;
    const result = redactText(input);
    expect(result.text).not.toContain(random);
    const start = input.indexOf(random);
    expect(result.spans.some((s) => s.start <= start && s.end >= start + random.length)).toBe(true);
    expectWellFormed(input, result);
  });

  it.each([
    ["a short ghp_ identifier", ["load", "_gh", "p_", "config"].join("")],
    ["a short github_pat_ identifier", ["my", "_github", "_pat_", "helper"].join("")],
    ["a snake_case name ending in sk-", ["task", "_sk-", "list"].join("")],
    ["sk- without a digit after _", ["x", "_sk-", "abcdefghijklmnopqrstuvwxyz"].join("")],
    ["a Stripe-like word that is too short", ["read", "_sk", "_live_", "mode"].join("")],
    ["live mode in snake case", ["work", "_live_", "abcdefghijklmnopqrstuv"].join("")],
  ])("leaves %s alone", (_name, input) => {
    const result = redactText(input);
    expect(result.spans).toEqual([]);
    expect(result.text).toBe(input);
  });
});

describe("redactJson", () => {
  it("masks strings at any depth and reports a path per masked string", () => {
    const value: JsonValue = {
      title: `deploy with ${fake.githubClassic}`,
      nested: { list: ["plain", `key ${fake.aws}`, 3, null, true] },
      count: 2,
    };
    const result = redactJson(value);
    expect(result.value).toEqual({
      title: `deploy with ${maskMarker("github-token")}`,
      nested: { list: ["plain", `key ${maskMarker("aws-access-key")}`, 3, null, true] },
      count: 2,
    });
    expect(result.masks.map((m) => m.path)).toEqual([["title"], ["nested", "list", 1]]);
    expect(result.masks[1]?.spans[0]?.kind).toBe("aws-access-key");
  });

  it("masks the whole string value of a sensitive property name", () => {
    const value: JsonValue = { auth: { password: "correct horse", apiKey: "abc", token: "" } };
    const result = redactJson(value);
    expect(result.value).toEqual({
      auth: {
        password: maskMarker("sensitive-value"),
        apiKey: maskMarker("sensitive-value"),
        token: "",
      },
    });
    const first = result.masks[0];
    expect(first?.path).toEqual(["auth", "password"]);
    expect(first?.spans).toEqual([
      {
        kind: "sensitive-value",
        start: 0,
        end: 13,
        maskedStart: 0,
        maskedEnd: maskMarker("sensitive-value").length,
      },
    ]);
  });

  it("masks a whole high-entropy string value", () => {
    const result = redactJson({ note: fake.generic40, commit: sha, id: uuid });
    expect(result.value).toEqual({ note: maskMarker("high-entropy"), commit: sha, id: uuid });
  });

  it("leaves skipped paths untouched", () => {
    const value: JsonValue = { requestId: fake.githubClassic, reason: fake.githubClassic };
    const result = redactJson(value, {
      skip: (path) => path.length === 1 && path[0] === "requestId",
    });
    expect(result.value).toEqual({
      requestId: fake.githubClassic,
      reason: maskMarker("github-token"),
    });
  });

  it("does not mutate its input and leaves non-strings alone", () => {
    const value: JsonValue = { a: [1, false, null, { password: "x1" }] };
    const copy = structuredClone(value);
    const result = redactJson(value);
    expect(value).toEqual(copy);
    expect(result.value).toEqual({
      a: [1, false, null, { password: maskMarker("sensitive-value") }],
    });
  });

  it("masks a dollar-prefixed sensitive value", () => {
    expect(redactJson({ password: "$ecret123" }).value).toEqual({
      password: maskMarker("sensitive-value"),
    });
  });

  it("masks a value that is only a reference prefix", () => {
    const literal = ["$", "{hunter2"].join("");
    expect(redactJson({ password: literal }).value).toEqual({
      password: maskMarker("sensitive-value"),
    });
  });

  it("keeps complete references readable", () => {
    const refs = ["$DB_PASSWORD", ["$", "{DB_PASSWORD}"].join(""), "$(cat ~/.pw)"];
    for (const ref of refs) expect(redactJson({ password: ref }).value).toEqual({ password: ref });
  });

  it("masks a value that starts with a mask marker", () => {
    expect(redactJson({ password: `${maskMarker("sensitive-value")}hunter2` }).value).toEqual({
      password: maskMarker("sensitive-value"),
    });
  });

  it("masks an Authorization header property", () => {
    expect(redactJson({ headers: { Authorization: "Basic dXNlcjpwYXNz" } }).value).toEqual({
      headers: { Authorization: maskMarker("sensitive-value") },
    });
  });

  it("seals an array under a sensitive name whole, objects inside it included (#194)", () => {
    expect(redactJson({ password: ["hunter2", ["x1"], { note: "plain" }] }).value).toEqual({
      password: maskMarker("sensitive-value"),
    });
  });

  it("keeps a __proto__ property as an own property", () => {
    const value = JSON.parse('{"__proto__": {"password": "x1"}, "a": 1}') as JsonValue;
    const result = redactJson(value);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(JSON.stringify(result.value)).toBe(
      `{"__proto__":{"password":"${maskMarker("sensitive-value")}"},"a":1}`,
    );
  });

  it("returns no masks for clean input", () => {
    const result = redactJson({ title: "Fix the tests", files: ["src/a.ts"], sha });
    expect(result.masks).toEqual([]);
  });
});

describe("redactJson: a sensitive key's whole value is sealed (#194)", () => {
  const M = maskMarker("sensitive-value");
  const rows: Array<[string, JsonValue, JsonValue]> = [
    ["nested object", { password: { value: "hunter2" } }, { password: M }],
    [
      "deeply nested object",
      { auth: { token: { a: { b: { c: "deep" } } } } },
      { auth: { token: M } },
    ],
    ["keys inside the value (roborev 5260)", { password: { hunter2: true } }, { password: M }],
    ["array of strings", { apiKey: ["a1", "b2"] }, { apiKey: M }],
    ["array of objects", { secret: [{ v: "x" }, { v: "y" }] }, { secret: M }],
    ["number", { token: 123456 }, { token: M }],
    ["negative and fractional numbers", { secret: [-1, 2.5] }, { secret: M }],
    ["boolean", { password: true }, { password: M }],
    ["empty containers", { token: { a: {}, b: [] } }, { token: M }],
    ["null stays null (nothing to hide)", { password: null }, { password: null }],
    [
      "a sensitive key inside a non-sensitive one",
      { config: { db: { password: { v: "x" } }, port: 5432 } },
      { config: { db: { password: M }, port: 5432 } },
    ],
    [
      "a reference inside an object is sealed too",
      { password: { from: "$DB_PASSWORD" } },
      { password: M },
    ],
  ];
  it.each(rows)("masks %s", (_name, input, expected) => {
    expect(redactJson(input).value).toEqual(expected);
  });

  const clean: Array<[string, JsonValue]> = [
    ["numbers under ordinary keys", { count: 3, port: 4807, ratio: 0.5, ok: true }],
    ["nested objects under ordinary keys", { config: { db: { host: "localhost", port: 5432 } } }],
    ["arrays of numbers", { durations: [12, 30, 7], flags: [true, false] }],
    [
      "keys that only contain a sensitive word",
      { keyboard: { layout: 1 }, tokenizer: { size: 512 } },
    ],
    ["a monkey key", { monkey: { banana: 2 } }],
    ["a complete reference directly under a sensitive key", { password: "$DB_PASSWORD" }],
  ];
  it.each(clean)("leaves %s alone", (_name, input) => {
    const result = redactJson(input);
    expect(result.value).toEqual(input);
    expect(result.masks).toEqual([]);
  });

  it("reports one mask for the sealed value, at its path", () => {
    const result = redactJson({ a: { password: { pin: 4242, list: [true, "x"] } } });
    expect(result.masks.map((m) => m.path)).toEqual([["a", "password"]]);
    expect(result.masks[0]?.spans[0]).toMatchObject({
      kind: "sensitive-value",
      start: 0,
      end: JSON.stringify({ pin: 4242, list: [true, "x"] }).length,
    });
  });

  it("respects skip", () => {
    const result = redactJson(
      { idempotencyKey: { nested: "keep-me", n: 1 }, token: { v: "mask" } },
      { skip: (path) => path[0] === "idempotencyKey" },
    );
    expect(result.value).toEqual({ idempotencyKey: { nested: "keep-me", n: 1 }, token: M });
  });

  it("keeps a __proto__ key in an ordinary object as data", () => {
    const value = JSON.parse('{"x": {"__proto__": {"token": 1}}}') as JsonValue;
    const out = redactJson(value).value as { x: object };
    expect(Object.getPrototypeOf(out.x)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe(`{"x":{"__proto__":{"token":"${M}"}}}`);
  });
});

// M2.22 (#211, M2.11 F2): a {name, value} pair (Kubernetes env, the GitHub API, AWS tags,
// HAR headers) holds the secret under a generic property, so the sibling name decides.
describe("redactJson: name and value pairs (M2.22)", () => {
  const M = maskMarker("sensitive-value");
  const rows: Array<[string, JsonValue, JsonValue]> = [
    [
      "name and value",
      { name: "DB_PASSWORD", value: "Xy7pass9word" },
      { name: "DB_PASSWORD", value: M },
    ],
    [
      "Name and Value",
      { Name: "PGPASSWORD", Value: "Xy7pass9word" },
      { Name: "PGPASSWORD", Value: M },
    ],
    ["key and value", { key: "MYSQL_PWD", value: "x1" }, { key: "MYSQL_PWD", value: M }],
    ["Key and Value", { Key: "dbPass", Value: "x1" }, { Key: "dbPass", Value: M }],
    [
      "value before name",
      { value: "x1", name: "SECRET_KEY_BASE" },
      { value: M, name: "SECRET_KEY_BASE" },
    ],
    ["a numeric value", { name: "DB_PASS", value: 1234 }, { name: "DB_PASS", value: M }],
    ["an object value", { name: "API_TOKEN", value: { a: 1 } }, { name: "API_TOKEN", value: M }],
    [
      "an array value",
      { name: "client_secret", value: ["a", "b"] },
      { name: "client_secret", value: M },
    ],
    [
      "a Kubernetes env list",
      {
        env: [
          { name: "PATH", value: "/usr/bin" },
          { name: "DB_PASSWORD", value: "x1" },
          { name: "PORT", value: "5432" },
        ],
      },
      {
        env: [
          { name: "PATH", value: "/usr/bin" },
          { name: "DB_PASSWORD", value: M },
          { name: "PORT", value: "5432" },
        ],
      },
    ],
    [
      "an extra sibling stays readable",
      { name: "DB_PASSWORD", value: "x1", source: "env" },
      { name: "DB_PASSWORD", value: M, source: "env" },
    ],
    [
      "a request header pair",
      { name: "Authorization", value: "Basic dXNlcjpwYXNz" },
      { name: "Authorization", value: M },
    ],
  ];
  it.each(rows)("seals the value of %s", (_name, input, expected) => {
    expect(redactJson(input).value).toEqual(expected);
  });

  const clean: Array<[string, JsonValue]> = [
    ["PATH", { name: "PATH", value: "/usr/bin" }],
    ["a numeric value of an ordinary name", { name: "PORT", value: 5432 }],
    ["a reference under a sensitive name", { name: "DB_PASSWORD", value: "$DB_PASSWORD" }],
    ["a null value", { name: "DB_PASSWORD", value: null }],
    ["a sensitive name with no value sibling", { name: "DB_PASSWORD", note: "rotate monthly" }],
    ["a value with no name sibling", { value: "Xy7pass9word-ish", label: "x" }],
    ["a non-string name", { name: 7, value: "keep" }],
    ["a key that is a path", { key: "src/redact/index.ts", value: "export" }],
    ["a name that only contains a sensitive word", { name: "tokenizer", value: "bpe" }],
    ["a pair in a different property", { name: "DB_PASSWORD", other: "keep" }],
  ];
  it.each(clean)("leaves %s alone", (_name, input) => {
    const result = redactJson(input);
    expect(result.value).toEqual(input);
    expect(result.masks).toEqual([]);
  });

  it("reports one mask at the value's path", () => {
    const result = redactJson({ env: [{ name: "DB_PASS", value: { deep: true } }] });
    expect(result.masks.map((m) => m.path)).toEqual([["env", 0, "value"]]);
  });

  it("respects skip on the value path", () => {
    const input: JsonValue = { name: "DB_PASS", value: "keep" };
    const result = redactJson(input, { skip: (path) => path[0] === "value" });
    expect(result.value).toEqual(input);
  });

  it("masks the same pair serialized inside a string", () => {
    const text = JSON.stringify({ name: "DB_PASSWORD", value: "Xy7pass9word" });
    expect(redactJson({ note: text }).value).toEqual({
      note: `{"name":"DB_PASSWORD","value":"${M}"}`,
    });
  });

  it("masks a value glued to a marker in a serialized pair", () => {
    const text = `{"name":"DB_PASS","value":${maskMarker("sensitive-value")}hunter2}`;
    expect(redactText(text).text).not.toContain("hunter2");
  });

  it("is idempotent", () => {
    const once = redactJson({ name: "DB_PASS", value: "x1" }).value;
    expect(redactJson(once).value).toEqual(once);
  });
});

describe("M2.22 names and flags", () => {
  it("masks the value after each leaking command in one line, leaving ports readable", () => {
    const pw = fake.password;
    const input = `PGPASSWORD=${pw} psql -p 5432 && mysql -uroot -p${pw} app && sshpass -p ${pw} ssh -p 2222 host`;
    const result = redactText(input);
    expect(result.text).not.toContain(pw);
    expect(result.text).toContain("psql -p 5432");
    expect(result.text).toContain("ssh -p 2222 host");
    expectWellFormed(input, result);
  });

  it("is idempotent", () => {
    const input = `mysql -p${fake.password} app; sshpass -p ${fake.password} ssh host; docker login -p ${fake.password} r`;
    const once = redactText(input).text;
    expect(redactText(once).text).toBe(once);
  });
});

describe("adversarial input", () => {
  const n = 100_000;
  const cases: Array<[string, string]> = [
    ["letters", "a".repeat(n)],
    ["capitals", "A".repeat(n)],
    ["JWT prefixes", "eyJ".repeat(n / 3)],
    ["JWT dots", `${"eyJa.".repeat(n / 5)}`],
    ["sk- prefixes", "sk-".repeat(n / 3)],
    ["ghp_ prefixes", "ghp_".repeat(n / 4)],
    ["_ghp_ prefixes", "_ghp_".repeat(n / 5)],
    ["_github_pat_ prefixes", ["_github", "_pat_"].join("").repeat(n / 12)],
    ["_sk- prefixes", "_sk-".repeat(n / 4)],
    ["_sk-ant- prefixes", "_sk-ant-".repeat(n / 8)],
    ["_sk_live_ prefixes", "_sk_live_".repeat(n / 9)],
    ["sk- then letters", `_sk-${"a".repeat(n)}`],
    ["_eyJ prefixes", "_eyJ".repeat(n / 4)],
    ["AKIA prefixes", "AKIA".repeat(n / 4)],
    ["unclosed quotes", 'x="'.repeat(n / 3)],
    ["escaped quotes", `PASSWORD="${"\\".repeat(n)}`],
    ["assignments", "a=".repeat(n / 2)],
    ["colons", "a:".repeat(n / 2)],
    ["long identifier", `${"A_".repeat(n / 2)}`],
    ["bearer spaces", `Bearer${" ".repeat(n)}`],
    ["bearer repeats", "Bearer ".repeat(n / 7)],
    ["unterminated PEM headers", "-----BEGIN PRIVATE KEY-----".repeat(n / 27)],
    ["dashes", "-".repeat(n)],
    ["URL schemes", "a://".repeat(n / 4)],
    ["URL user parts", `http://${"a:".repeat(n / 2)}`],
    ["flags", "--token ".repeat(n / 8)],
    ["unclosed command substitutions", "PASSWORD=$(".repeat(n / 11)],
    ["unclosed braced references", ["PASSWORD=$", "{{ ".repeat(n / 3)].join("")],
    ["mask markers", "PASSWORD=[REDACTED:x]".repeat(n / 21)],
    ["random base62", body(n, 19)],
    ["Authorization schemes", "Authorization: Token ".repeat(n / 21)],
    ["Authorization spaces", `Authorization: Token${" ".repeat(n)}`],
    ["Authorization values", `Authorization: Token ${"a".repeat(n)}`],
    ["-u flags", "-u ".repeat(n / 3)],
    ["attached -u flags", "-u".repeat(n / 2)],
    ["--user= chains", "--user=".repeat(n / 7)],
    ["--user=a: chains", "--user=a:".repeat(n / 9)],
    ["-u long user", `-u ${"a".repeat(n)}:b`],
    ["-u long password", `-u a:${"b".repeat(n)}`],
    ["quoted -u users", '-u "a":'.repeat(n / 7)],
    ["Authorization parameters", "Authorization: Digest a=1, ".repeat(n / 27)],
    ["unterminated Authorization parameter", `Authorization: Digest a="${"x".repeat(n)}`],
    ["escaped Authorization parameters", 'Authorization: Digest a=\\"'.repeat(n / 26)],
    ["Authorization parameter lists", `Authorization: Digest ${"a=b,".repeat(n / 4)}`],
    ["Authorization headers on one line", "Authorization: Digest a=1 ".repeat(n / 25)],
    ["quoted -u segments", '-u "a"'.repeat(n / 6)],
    ["-u references", "-u $(a)".repeat(n / 7)],
    ["escaped space-led Authorization values", `Authorization: Digest a=" ${'\\"'.repeat(n / 2)}`],
    // M2.22: the command-scoped password flags and the name and value pair.
    ["mysql repeats", "mysql ".repeat(n / 6)],
    ["mysql -p repeats", "mysql -p ".repeat(n / 9)],
    ["mysql -p attached repeats", "mysql -pa ".repeat(n / 10)],
    ["mysql long word", `mysql ${"a".repeat(n)}`],
    ["mysql unterminated quotes", 'mysql "'.repeat(n / 7)],
    ["mysql escaped quotes", `mysql -p"${"\\".repeat(n)}`],
    ["mysql references", "mysql $(a) ".repeat(n / 11)],
    ["mysql many flags", `mysql ${"-a ".repeat(n / 3)}`],
    ["sshpass -p repeats", "sshpass -p ".repeat(n / 11)],
    ["sshpass -p words", "sshpass -p a ".repeat(n / 13)],
    ["sshpass -f repeats", "sshpass -f ".repeat(n / 11)],
    ["docker login repeats", "docker login ".repeat(n / 13)],
    ["docker login -p repeats", "docker login -p ".repeat(n / 16)],
    ["docker login many flags", `docker login ${"-p ".repeat(n / 3)}`],
    ["podman  login spaces", `podman login${" ".repeat(n)}`],
    ["name and value pairs", '{"name": "A_PASS", "value": '.repeat(n / 28)],
    ["name pairs with long values", `{"name":"A_PASS","value":"${"a".repeat(n)}`],
    ["name pairs without values", '{"name":"A_PASS",'.repeat(n / 17)],
    ["name pairs with quotes", `{"name":"${"A_".repeat(n / 2)}`],
  ];

  it.each(cases)("%s finishes quickly", (_name, input) => {
    const started = performance.now();
    redactText(input);
    // Linear scans take about 20 ms here when run alone. The bound is loose so a
    // busy parallel run does not flake, yet far below the tens of seconds a
    // quadratic scan of 100,000 characters takes (one such regression took 55 s).
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
