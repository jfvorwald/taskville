# Spike S-3: staging and hosting shape for a local-first app

- **Ticket:** M7.01 (#81). **Recorded:** 2026-11-06 on main `bc0457f`, macOS, Node 26.
- **Inputs:** ARCHITECTURE.md section 13 (staging bullet), `~/dev/AGENTS.md` (app staging and production), `jaqstudios/docs/STAGING.md` (shared portal, release helper, receipts).
- **Scope:** how Taskville gets an isolated, access-controlled staging environment and an exact-artifact promotion path. Nothing here changes ARCHITECTURE.md or the constitution. The hosting choice is the owner's (decision recorded on #81).

## The problem

The parent staging rules assume a hosted app: a private staging host behind the JAQ Studios App Launcher, a frozen release, a staging receipt, and production as a promotion of that exact artifact. Taskville is not hosted. Production is a person running `taskville start` on their own machine, with the engine bound to `127.0.0.1` and every request checked for a loopback `Host` (ARCHITECTURE.md section 13, `apps/engine/src/http/middleware.ts`). Its users are local Claude Code sessions, not visitors.

So staging has two jobs, and they need different shapes:

1. **A place the owner can open and review a release in a browser**, through the portal, signed in, with a staging banner and the release identity visible.
2. **Proof that the exact packaged artifact installs and runs** on a clean machine: `start`, pairing, `init`, `doctor`, the hook shim, `demo`. This is what "production" actually means for Taskville.

## What the engine needs (measured)

| Measure | Value | How |
| --- | --- | --- |
| Engine resident memory, idle, paired, 3 projects | about 43 MB | `ps -o rss` on the owner's running engine |
| Taskville home after 3 days of use and demos | 19 MB, of which SQLite 5.1 MB | `du -sh ~/.taskville` |
| Built web client (`apps/web/dist`) | 12 MB | `du -sh`; largest single asset well under the 25 MiB Workers static asset limit |
| Runtime | Node 26.8+ with `node:sqlite` | `package.json` engines, `apps/engine/src/storage/sqlite.ts` |
| Network | one loopback port; no outbound calls | ARCHITECTURE.md section 13 |

`packages/demo`, `packages/domain` and `packages/protocol` import nothing from `node:`. The deterministic demo producer (`taskville demo run --seed <n> --duration <sim-time> --offline`, the `runOffline` API in `packages/demo`) and the domain reducer can run in a Worker or a browser unchanged.

The web client reads `/v1/projects`, `/v1/projects/<id>/snapshot`, the project and attention SSE streams, `/v1/agents/...` (feed and agent panel), `/v1/timelines/...` (history), and `/v1/evidence/...`, and posts `/v1/pairing`, `/v1/commands`, and `/v1/requests/...`.

## Options

### A. Hosted engine in a container behind Access

Run the packaged engine plus `taskville demo` in a Cloudflare Container (or a small VM), fronted by a Worker with an Access policy.

- For: exercises the real engine over HTTP.
- Against: the engine refuses any non-loopback `Host` by design ("Deliberately not configurable", `apps/engine/src/http/server.ts`). Hosting it means adding a staging-only host and origin allowlist and rethinking pairing (the pairing link is printed to a terminal nobody is watching). That is a change to section 13's security model, so it needs an architecture decision. Containers also need Workers Paid, a new spend the existing Zero Trust approval does not cover. It is a second always-on service to secure, including its fallback origins.

### B. Packaged engine on an always-on machine via Cloudflare Tunnel

Run the engine on a spare Mac or VPS, expose it with `cloudflared` and an Access application. The tunnel can rewrite `Host` to `127.0.0.1:<port>`, so the loopback check passes unchanged.

- For: no engine code change for reads. Free tier.
- Against: state-changing routes still check `Origin`, so pairing and commands fail without the same staging-only allowlist as A. It depends on a machine staying up and patched. The tunnel's own origin and any `*.cfargotunnel.com` path must be locked down. It looks too much like "a browser on the internet can reach a permission bridge", which section 13 exists to prevent, even with synthetic sources.

### C. Static staging Worker with an in-Worker demo engine, plus a clean-machine artifact check (recommended)

Two parts, matching the two jobs:

1. **Review staging (hosted).** A Worker named `taskville-staging` at `taskville-staging.jaqstudios.com`, behind the existing App Launcher and its owner-only Access policy, with `workers.dev` and version preview URLs disabled, exactly like JAQ Studios and EPOCH. It serves the frozen `apps/web/dist` from the release unchanged, plus a small read-only `/v1` implementation backed by `packages/demo` and `packages/domain`: projects, snapshots, SSE streams, agent feeds, timelines and evidence, all fed by a seeded demo run. Every browser read route above is served or answers an explicit empty result, never a 404 the client treats as a failure. **First-visit pairing:** the unchanged client needs a one-time `#pair=` code, and its session secret lives in `localStorage`, so the Worker cannot see it on a page load. `/` therefore always serves the app unchanged; reloads keep working from the stored secret. A separate entry route, `/pair`, is the link the App Launcher points at: after verifying the Access JWT it redirects to `/#pair=<code>` with a fresh single-use code (10 minute TTL) bound to that Access identity, and `POST /v1/pairing` exchanges it for a session secret exactly as the engine does. The staging build's Not paired screen links to `/pair`. Codes and session secrets live in one Durable Object (strongly consistent, so a code redeems exactly once whichever Worker instance handles the request); nothing is pairable without a valid Access JWT. The staging browser check in M7.04 covers first visit, reload, a reused code and a revoked session. `/v1/commands` and `/v1/requests/` answer with synthetic outcomes and reach nothing: there is no permission bridge, no hook shim, no real agent. A staging banner and the release ID show in the header.
2. **Artifact check (local-first "production").** M7.02 packages the CLI, the engine and the built web client as one frozen release (a single installable tarball whose web `dist` sits where `taskville start` resolves `index.html`, plus a manifest of hashes and a release ID). A CI job installs that exact tarball on a clean runner with a fresh `TASKVILLE_HOME` and runs `start --no-open`, pairing through the printed link in headless Chromium, `init --yes` in a throwaway repo, `doctor`, a replayed hook fixture, and `demo`. It records a receipt next to the release. Promotion means publishing that same tarball (a GitHub release), never a rebuild.

- For: no change to the engine's security model. Fits the existing release helper, receipts, portal and Access setup with no new spend. Section 13's "never connected to real agents' permission bridges" holds structurally, not by configuration. The artifact check covers what a hosted engine would, on the path users actually take.
- Against: review staging does not run the Node engine, so engine bugs show up in the artifact check rather than in the browser on staging. The in-Worker `/v1` is a second implementation of the read API that can drift. Mitigation: it reuses the protocol schemas, and a contract test runs every route the web client calls (the list above, kept in sync by a test that greps the client for `/v1/` paths) against both.

## Recommendation

**Option C.** It satisfies every staging rule without changing ARCHITECTURE.md:

| Rule | How C meets it |
| --- | --- |
| Isolated database, evidence, credentials | Review staging has no database or credentials; the artifact check uses a throwaway home on a CI runner |
| Synthetic or read-only sources | Seeded `packages/demo` only |
| Access-controlled, signed-out denial verified | Access app on the staging hostname; M7.04 checks root, assets and `/v1/*` signed out, and fallback and preview URLs return 404 |
| Never connected to real permission bridges | No bridge exists in the Worker; command routes are synthetic |
| Staging indicator and release identity | Header banner plus release ID, matched to the receipt |
| Promote the exact reviewed artifact | Release tarball plus manifest plus staging receipt; promotion publishes the same bytes |

Mapping to the remaining tickets:

- **M7.02 (#83):** a release script producing `.releases/<id>/` with the installable tarball (CLI, engine and web `dist` together), the staging Worker bundle (the same web `dist` plus the demo `/v1`), and `manifest.json`, adapted from `jaqstudios/scripts/release.mjs`.
- **M7.03 (#84):** the `taskville-staging` Worker and its demo-backed `/v1`, plus the contract test.
- **M7.04 (#86):** the Access policy and signed-out and signed-in verification.
- **M7.05 (#85):** the runbook: backup and restore of a Taskville home, schema compatibility across versions, rollback to a previous release tarball, promotion.
- **M7.06 (#87):** push-tier suite plus the clean-machine artifact check plus the release security review.

## Owner decision

Recorded on #81. The default if no answer arrives: proceed with C. The alternatives are A (hosted engine, needs an architecture change and Workers Paid) and B (tunnel to an always-on machine, needs a staging origin allowlist).
