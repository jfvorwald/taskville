// Requests and commands sub-reducer (data-model.md "Requests and commands", ARCHITECTURE.md
// sections 2.2 and 6). Pure and deterministic: time comes from events only, and no rule depends on
// object key order, so a projection restored from canonical JSON reduces like a live one.

export { initialRequestsState, reduceRequests } from "./requests.ts";
export { BRIDGE_SOURCE_ID } from "./sources.ts";
export type { Command, PendingRequest, RequestsState } from "./types.ts";
