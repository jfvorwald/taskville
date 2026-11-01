// Permission bridge (ARCHITECTURE.md 8.1 and 9, spike S-1, decision #116): holds Claude Code's
// PermissionRequest hook response for the city, and records how each request ended.
export {
  type BridgeDecision,
  createPermissionBridge,
  DEFAULT_HOLD_WINDOW_MS,
  type HeldRequest,
  MAX_TRACKED_REQUESTS,
  PermissionBridge,
  type PermissionBridgeOptions,
} from "./bridge.ts";
export { commitEngineEvent, type EngineCommitOptions } from "./commit.ts";
export { BRIDGE_PERMISSION_PATH, registerBridgeRoutes } from "./route.ts";
