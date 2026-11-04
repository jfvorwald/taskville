import { describe, expect, it } from "vitest";
import { redactText } from "../src/redact/index.ts";

// M7.12 (#222 gaps G-1 to G-4, #215 F5). Fake secrets are assembled at runtime so no
// token-shaped literal sits in the source. None is real.

function chars(n: number, alphabet: string, seed: number): string {
  let s = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += alphabet[(s >>> 8) % alphabet.length];
  }
  return out;
}

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const pw = ["s3", "cr3t", "pa", "ss"].join("");

function expectMasked(input: string, secret: string) {
  const result = redactText(input);
  expect(result.text).not.toContain(secret);
  expect(result.spans.length).toBeGreaterThan(0);
}

describe("M7.12 G-1: quoted docker/podman subcommand", () => {
  it.each([
    ["docker double-quoted login", `docker "login" -p ${pw} reg`],
    ["docker single-quoted login", `docker 'login' -p ${pw} reg`],
    ["podman double-quoted login", `podman "login" -p ${pw} reg`],
    ["docker partly quoted login", `docker lo"gin" -p ${pw} reg`],
    ["docker escaped login", `docker log\\in -p ${pw} reg`],
    ["docker quoted login, --password", `docker "login" --password ${pw} reg`],
    ["docker quoted login, attached -p", `docker "login" -p${pw} reg`],
  ])("masks %s", (_name, input) => {
    expectMasked(input, pw);
  });
});

describe("M7.12 G-2: docker login inside a quoted word", () => {
  it.each([
    ["sh -c single quoted", `docker exec runner sh -c 'docker login -p ${pw} reg'`],
    ["sh -c double quoted", `docker exec runner sh -c "docker login -p ${pw} reg"`],
    ["bash -lc nested podman", `ssh host bash -lc 'podman login --password ${pw} reg'`],
    ["quoted after another docker", `docker ps; docker exec r sh -c 'docker login -p ${pw} reg'`],
    ["inner docker after an outer login", `docker login reg && sh -c 'docker login -p ${pw} reg'`],
  ])("masks %s", (_name, input) => {
    expectMasked(input, pw);
  });
});

describe("M7.12 G-3: no word cap before -p<password>", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join(" ");
  it.each([
    ["mysqldump", (n: number) => `mysqldump -u root ${many(n)} -p${pw}`],
    ["mysql", (n: number) => `mysql ${many(n)} -p${pw}`],
  ])("masks the password of %s after many words", (_name, make) => {
    for (const n of [300, 5000]) expectMasked(make(n), pw);
  });

  // sshpass options end at its first non-option word (the command), so a long run of words
  // before -p is not an sshpass password; the uncapped walk is covered by this long command tail.
  it("keeps a port readable in a long sshpass command", () => {
    const input = `sshpass -p ${pw} ssh ${"h ".repeat(400)}-p 2222 host`;
    const result = redactText(input);
    expect(result.text).not.toContain(pw);
    expect(result.text).toContain("-p 2222 host");
  });
});

describe("M7.12 G-4: name and value pair with properties between", () => {
  it.each([
    ["type between", `{"name":"DB_PASSWORD","type":"secure","value":"${pw}"}`],
    [
      "spaced, two properties between",
      `{"name": "DB_PASSWORD", "a": 1, "b": "x", "value": "${pw}"}`,
    ],
    ["multi-line", `{\n "name": "API_PASSWORD",\n "type": "secure",\n "value": "${pw}"\n}`],
    [
      "in an array of settings",
      `[{"name":"OK","value":"v"},{"name":"DB_PASSWORD","type":"secure","value":"${pw}"}]`,
    ],
  ])("masks %s", (_name, input) => {
    expectMasked(input, pw);
  });

  it("does not carry a name across objects to a later value", () => {
    const input = `{"name":"DB_PASSWORD"}, {"type":"t","value":"plainvalue"}`;
    expect(redactText(input).text).toBe(input);
  });

  it("leaves a non-sensitive name with a distant value readable", () => {
    const input = `{"name":"REGION","type":"plain","value":"eu-west-1"}`;
    expect(redactText(input).text).toBe(input);
  });
});

describe("M7.12 #215: keys after a hyphen", () => {
  const filler = "a-".repeat(150); // 300 chars joined by dashes, low entropy
  const anthropic = ["sk", "-ant-", "api03-", chars(40, B62, 41)].join("");
  const anthropicLower = ["sk", "-ant-", "api03-", "abc".repeat(10)].join("");
  const jwtLow = ["ey", "Jaaaaa.", "ey", "Jaaaaa.", "aaaaaa"].join("");
  const openai = ["sk", "-", chars(30, B62, 42)].join("") + "7";
  const slackLower = ["xo", "xb-", "1234567890", "12-", chars(24, LOWER, 43)].join("");
  const jwt = [
    "ey",
    "JhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    ".",
    "ey",
    "JzdWIiOiJ0ZXN0LXVzZXIiLCJpYXQiOjB9",
    ".",
    chars(43, B62, 44),
  ].join("");

  it.each([
    ["sk-ant after a long dash run", `${filler}${anthropic}`, anthropic],
    ["sk- after a long dash run", `${filler}${openai}`, openai],
    ["xoxb lowercase after a long dash run", `${filler}${slackLower}`, slackLower],
    ["jwt after a long dash run", `${filler}${jwt}`, jwt],
    ["x-sk-ant- lowercase body", `x-${anthropicLower}`, anthropicLower],
    ["x-sk- with a 20+ char body", `x-${openai}`, openai],
    ["x-xoxb- lowercase body", `x-${slackLower}`, slackLower],
    ["low-entropy jwt after a hyphen", `x-${jwtLow}`, jwtLow],
    ["low-entropy jwt after a long dash run", `${filler}${jwtLow}`, jwtLow],
    ["low-entropy x-sk- body", `x-${["sk", "-"].join("")}${"ab1".repeat(8)}`, "ab1".repeat(8)],
  ])("masks %s", (_name, input, secret) => {
    expectMasked(input, secret);
  });

  it.each([
    ["task-sk-1", "task-sk-1"],
    ["risk-assessment", "risk-assessment"],
    ["x-sk- with a short body", "x-sk-short1"],
    ["x-sk- with a 19 char body", `x-sk-${"a1".repeat(9)}b`],
    ["sk- word in a hyphen list", "disk-sk-backup-sk-restore-notes"],
    ["x-sk-ant- with a short body", "x-sk-ant-abc123"],
    ["x-xoxb- with a short body", "x-xoxb-abc"],
    ["eyJ word after a hyphen, no dots", "my-eyJab-notes"],
    ["ordinary hyphenated prose", "well-known state-of-the-art risk-averse task-runner"],
  ])("leaves %s readable", (_name, input) => {
    const result = redactText(input);
    expect(result.text).toBe(input);
    expect(result.spans).toEqual([]);
  });
});

describe("M7.12 linear-time guard", () => {
  const n = 100_000;
  const bound = 2000; // generous: linear scans take tens of ms, quadratic ones tens of seconds
  const cases: Array<[string, string]> = [
    ["quoted docker repeats", `docker "login" `.repeat(n / 16)],
    ["unclosed quoted sh -c docker", `sh -c 'docker `.repeat(n / 15)],
    ["nested quotes with docker", `sh -c "sh -c 'docker login -p `.repeat(n / 30)],
    ["docker inside many quoted words", `sh -c 'docker exec x' `.repeat(n / 22)],
    ["mysql with huge word count", `mysql ${"w ".repeat(n / 2)}`],
    ["mysql repeated, long", "mysql a b c ".repeat(n / 12)],
    ["mysqldump -p repeats", "mysqldump -p ".repeat(n / 13)],
    ["sshpass with huge word count", `sshpass ${"w ".repeat(n / 2)}`],
    ["sshpass repeats", "sshpass x ".repeat(n / 10)],
    ["pairs with many properties between", `{"name":"A_PASS"${',"k":1'.repeat(n / 8)}}`],
    ["name then many keys, repeated", '{"name":"A_PASS","k":1,'.repeat(n / 24)],
    ["names with typed gaps", '{"name":"A_PASS","type":"t",'.repeat(n / 27)],
    ["dash runs", "a-".repeat(n / 2)],
    ["x-sk- repeats", "x-sk-".repeat(n / 5)],
    ["dash then sk-ant- repeats", "-sk-ant-".repeat(n / 8)],
    ["dash then xoxb- repeats", "-xoxb-".repeat(n / 6)],
    ["dash then eyJ repeats", "-eyJa.".repeat(n / 6)],
    ["dash then eyJ eyJ repeats", "-eyJaaaaa.eyJaaaaa".repeat(n / 18)],
    ["one long dash run with sk- inside", `${"sk-".repeat(n / 6)}${"-a".repeat(n / 4)}`],
  ];

  it.each(cases)("%s finishes quickly", (_name, input) => {
    const started = performance.now();
    redactText(input);
    expect(performance.now() - started).toBeLessThan(bound);
  });
});
