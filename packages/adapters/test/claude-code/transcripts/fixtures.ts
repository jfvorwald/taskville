// Synthetic Claude Code transcript fixtures (M8.02). The repo holds no real transcript, so these
// follow the documented shape: one JSON object per line, `type` user or assistant, a `message`
// with content blocks (text, tool_use, tool_result), plus `timestamp`, `sessionId`, `uuid`,
// `parentUuid`, `cwd`, and `isSidechain` (with `agentId`) for subagent lines. Secrets are built at
// run time so no secret-shaped literal sits in the repository.

export const SESSION = "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
export const SUB_AGENT = "afdf84bea07a9064c";
export const CWD = "/tmp/spike-m802/proj";

export const T = (n: number): string => new Date(Date.UTC(2026, 10, 1, 9, 0, n)).toISOString();

/** An API-key-shaped string the redactor masks as `anthropic-key`. Not a real key. */
export const fakeApiKey = (): string => `sk-ant-${"A1b2C3d4E5f6G7h8I9j0K1l2M3"}`;
/** An env assignment with a sensitive name, which the redactor masks. Not a real password. */
export const fakeEnvAssignment = (): string => `DATABASE_PASSWORD=${"hunter2hunter2"}`;

let counter = 0;
const uuid = (): string => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

interface Extra {
  sessionId?: string;
  sidechain?: boolean;
  agentId?: string;
  ts: string;
}

function envelope(type: "user" | "assistant", message: unknown, extra: Extra) {
  return {
    parentUuid: null,
    isSidechain: extra.sidechain === true,
    ...(extra.agentId === undefined ? {} : { agentId: extra.agentId }),
    userType: "external",
    cwd: CWD,
    sessionId: extra.sessionId ?? SESSION,
    version: "2.1.0",
    type,
    message,
    uuid: uuid(),
    timestamp: extra.ts,
  };
}

export const userPrompt = (text: string, extra: Extra) =>
  envelope("user", { role: "user", content: text }, extra);

export const assistantText = (text: string, extra: Extra, stopReason: string | null = null) =>
  envelope(
    "assistant",
    {
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
    },
    extra,
  );

export const assistantToolUse = (id: string, name: string, input: unknown, extra: Extra) =>
  envelope(
    "assistant",
    {
      role: "assistant",
      model: "claude-test",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
    },
    extra,
  );

export const toolResult = (id: string, content: unknown, extra: Extra, isError = false) =>
  envelope(
    "user",
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
      ],
    },
    extra,
  );

/** A complete session of 8 lines: prompt, a Bash call, a subagent that reads a file, turn end. */
export function completeSession(): object[] {
  return [
    userPrompt("Run the tests and have a helper read notes.txt", { ts: T(0) }), // 1
    assistantToolUse(
      "toolu_BASH",
      "Bash",
      { command: "pnpm test", description: "Run tests" },
      { ts: T(1) },
    ), // 2
    toolResult("toolu_BASH", "all green", { ts: T(2) }), // 3
    assistantToolUse(
      "toolu_AG",
      "Agent",
      { description: "Read notes", prompt: "Read notes.txt" },
      { ts: T(3) },
    ), // 4
    assistantToolUse(
      "toolu_SUB",
      "Read",
      { file_path: `${CWD}/notes.txt` },
      { ts: T(4), sidechain: true, agentId: SUB_AGENT },
    ), // 5
    toolResult("toolu_SUB", [{ type: "text", text: "line one" }], {
      ts: T(5),
      sidechain: true,
      agentId: SUB_AGENT,
    }), // 6
    toolResult("toolu_AG", "notes read", { ts: T(6) }), // 7
    assistantText("Tests pass and the notes are read.", { ts: T(7) }, "end_turn"), // 8
  ];
}

export const jsonl = (lines: readonly (object | string)[]): string =>
  `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;
