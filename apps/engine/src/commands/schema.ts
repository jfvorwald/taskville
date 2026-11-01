import { idSchema } from "@taskville/protocol";
import { z } from "zod";

// The `POST /v1/commands` body (ARCHITECTURE.md 9.2, contracts/http-api.md). Strict at every
// level: an unknown key, such as a `cwd` or an opener `template` on session.open, is a bad
// request, so a request can never supply what only the recorded session and the config may.

/** The most characters of a deny note passed to the agent. */
export const MAX_DENY_MESSAGE_CHARS = 1000;

const contextSchema = z.strictObject({ mode: z.enum(["live", "history"]) });

const commonShape = {
  projectId: idSchema,
  requestId: idSchema,
  idempotencyKey: idSchema,
  context: contextSchema.optional(),
};

const decisionSchema = z.discriminatedUnion("behavior", [
  z.strictObject({ behavior: z.literal("allow") }),
  z.strictObject({
    behavior: z.literal("deny"),
    message: z.string().max(MAX_DENY_MESSAGE_CHARS).optional(),
  }),
]);

const permissionDecideSchema = z.strictObject({
  type: z.literal("permission.decide"),
  ...commonShape,
  decision: decisionSchema,
});

const sessionOpenSchema = z.strictObject({
  type: z.literal("session.open"),
  ...commonShape,
  sessionId: idSchema,
});

export const commandBodySchema = z.discriminatedUnion("type", [
  permissionDecideSchema,
  sessionOpenSchema,
]);

export type CommandBody = z.infer<typeof commandBodySchema>;
export type PermissionDecideBody = z.infer<typeof permissionDecideSchema>;
export type SessionOpenBody = z.infer<typeof sessionOpenSchema>;
