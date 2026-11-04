# Envelope module contract (M5.04, written by the test-writer for the implementer)

Files to create in this directory (the tests import exactly these names):

`envelopes.ts` (pure, no React or three):
- `ENVELOPE_FLIGHT_MS`: number, flight time sender to recipient on the store clock.
- `interface Envelope { id: string; fromAgentId: string; toAgentId: string | null; to: string; kind: TeamMessageKind; summary?: string; sentAt: number }`
  `id` is the `eventId` of the `team.message` event. `to` is the payload value as written.
  `toAgentId` is the agent whose `displayName` (case-insensitive) or `sourceAgentId` equals `to`, else null.
- `envelopeFor(event, agents, sentAt): Envelope | null`: null unless `event.type === "team.message"`.
- `envelopeLabel(envelope, agents): string`: hover text, `"<from name> to <to name>"` plus `": <summary>"` when a summary exists. Names are `displayName`, falling back to the id (sender) or the raw `to` (unresolved recipient).
- `createEnvelopeLog()`: `{ observe(event, agents, sentAt): Envelope | null; live(now): readonly Envelope[] }`. `observe` returns null for non-message events and for an `eventId` already seen (a replayed event never makes a second envelope). `live(now)` lists envelopes with `now - sentAt < ENVELOPE_FLIGHT_MS` in send order.

`feedFocus.ts`: `createFeedFocus()` returning `{ request(agentId, eventId): void; getSnapshot(): { agentId: string; eventId: string } | null; subscribe(l): () => void }`. The hand-off the agent panel will read to open the Live feed on the message (the panel is outside this ticket's Owns).

`EnvelopeLayer.tsx`: `EnvelopeLayer({ store?, anchors?, selection?, feedFocus?, reducedMotion? })`, mounted inside a `<Canvas>`. Defaults: `dataStore`, `worldAnchors`, the app `selectionStore`, a shared `feedFocus` export.
- Listens with `store.onEvent`, stamps `sentAt = store.now()`, flies one envelope per `team.message` from the sender's `agentAnchorId` anchor to the recipient's (an unresolved recipient: implementer's choice, untested), and drops it after `ENVELOPE_FLIGHT_MS`. Progress = `(store.now() - sentAt) / ENVELOPE_FLIGHT_MS`, so a frozen test clock freezes the envelope.
- Exactly one Object3D per envelope carries `userData.envelopeId === envelope.id` (the root of the paper mesh), so tests can find and project it.
- Hovering it with a real pointer renders a DOM element with `role="tooltip"` whose text is `envelopeLabel`; it disappears when the pointer leaves.
- A real click on it calls `selection.select(fromAgentId)` and `feedFocus.request(fromAgentId, id)`, and must survive the `InteractionLayer` release handler (which clears the selection over empty ground).

Run the tests (browser config; apps/web's node project only includes `test/**`):
`pnpm --filter @taskville/web exec vitest run --config vitest.browser.config.ts src/city/crew/envelopes/<file>`
