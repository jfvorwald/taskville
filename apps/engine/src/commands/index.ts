// Command service (ARCHITECTURE.md 9, decision #116 D4): the authenticated route that answers a
// held permission request or opens a session, and records every command and its outcome.
export { registerCommandRoutes } from "./routes.ts";
export {
  type CommandBridge,
  type CommandBridgeDecision,
  type CommandResult,
  type CommandService,
  type CommandServiceOptions,
  type CommandView,
  createCommandService,
  type HeldRequest,
  type SessionOpenResult,
} from "./service.ts";
