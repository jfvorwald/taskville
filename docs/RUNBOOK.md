# Runbook: backup, compatibility, rollback, promotion

Owner: M7.05 (#85). Scope: how a Taskville release is built, staged, backed up, rolled back and promoted. Read [the staging spike](spikes/S-3-staging.md) for why staging is shaped this way.

Every command below is copied from a script, a package file, a CLI usage line, or a ticket doc in this repo. Steps that the repo does not script are marked **manual** or **not verified**.

## 1. What production and staging mean

> **Hosted staging is held** by decision #432 (2026-11-07). The staging steps in this section, section 3, and the Staging part of section 6 are not rehearsed. They are kept as written for when staging resumes. The local rehearsal in section 8 is the current review path.

**Production is the published release tarball.** Taskville is not hosted. A user installs one tarball, `taskville-<version>.tgz`, and runs `taskville start` on their own machine. The engine listens on `127.0.0.1` only. Promoting a release means publishing that exact tarball, with its `release.json` and `manifest.json`, for users to install. There is no production server to deploy to.

**Staging is a review copy.** The staging Worker (`taskville-staging`, at `taskville-staging.jaqstudios.com`) serves the release's web client behind an owner-only Cloudflare Access policy. It is for a person to open the release in a browser and review it.

- Demo data only. The Worker serves a seeded demo run from `packages/demo`. It has no database of user data.
- No permission bridge. Commands and held requests get synthetic refusals. No agent is connected.
- No engine process. The Worker is not the Node engine. Engine bugs show up in the clean-machine install check, not on staging.
- A staging banner (`STAGING`) and the release id show in the header once the browser is paired.

## 2. Building a release and reading its identity

### Build

From the repository root, on a clean committed tree:

```sh
pnpm release --out <dir>
pnpm release --out <dir> --environment staging
```

Source: the root `release` script (`node scripts/release/src/main.ts`) and its usage line. `--allow-dirty` exists, but never use it for a release: it builds from uncommitted changes, and `release.json` then records `"dirty": true`.

**The default environment is `production`.** For a staging build, pass `--environment staging`. The flag sets the `environment` field in the tarball's `release.json`. It does not configure the staging Worker (see section 3).

The build refuses a dirty tree, a lockfile whose installed packages are not in `pnpm-lock.yaml`, and any credentials-looking file (`.env*`, `.dev.vars*`, `.npmrc`, keys) in the package. It also refuses to overwrite an existing `<id>/` folder whose files differ.

To check the release builder itself, run the root `test:release` script (`vitest run --root scripts/release`).

### Output

```
<dir>/<release id>/
  taskville-<version>.tgz   the installable package (web client, CLI bundle, hooks)
  release.json              id, version, commit, environment (and dirty, if true)
  manifest.json             digest, file hashes, and the sha256 of the tarball
```

- **Release id:** the first 16 hex characters of a SHA-256 over the version, environment, commit, dirty flag, lockfile hash and every packaged file. The same content gives the same id.
- **Tarball layout:** everything sits under `package/`. The web client is `package/web/`, and `release.json` is at `package/release.json`.
- **`manifest.json`:** `id`, `digest`, `version`, `commit`, `environment`, `lockfile.sha256`, `release.sha256` (of `release.json`), `files[]` (path, size, sha256 for each file), and `tarball.sha256`.
- **Tarball hash:** the gzip bytes can differ between Node and zlib builds (M7.02 deferred note). The release id is the stable identity. The tarball's `tarball.sha256` is only valid for the file that was built, so promotion publishes that file and never rebuilds (section 7).

### Reading the identity

| Where | What it shows |
| --- | --- |
| `taskville --version` | `taskville <version> (<release id>)`. Shows `dev` as the id in a source checkout, which has no `release.json`. Source: `versionLine` in `apps/cli/src/main.ts`. |
| The web header badge | `<environment> · <first 12 characters of the id>`, for example `staging · 20261106-abc`. It appears only when `/health` returns an identity. Source: `ReleaseBadge.tsx` and `SHORT_ID_LENGTH` in `identity.ts`. |
| `GET /health` (engine) | `release: { id, version, environment }`, read from `release.json` next to the engine's entry point. Missing or invalid `release.json` falls back to the `dev` identity with a warning. |
| `GET /health` (staging Worker) | `release: { id, version, environment }`, read from the Worker's `RELEASE_ID`, `RELEASE_VERSION` and `APP_ENV` variables. |
| The `STAGING` banner | Shown only when the environment is `staging`. |

Staging's identity comes from the Worker's variables, not from `release.json`. Compare the id on the page with the id in `manifest.json` by hand.

## 3. Deploying the staging Worker from a release

> **Held by decision #432 (2026-11-07).** Hosted staging is on hold. These steps are not rehearsed; they are kept as written for when staging resumes.

Source: `deploy/staging/wrangler.jsonc` and `docs/tasks/M7.03.md`. Nothing here is automated yet. Run each step by hand, and only from the release you intend to review.

1. **Get the web client from the tarball (manual).** Extract only `package/web/` from `taskville-<version>.tgz` into a new, empty folder, then copy its contents into `deploy/staging/dist/`. Do not extract anything else into the Worker folder. The repo has no script for this step. The M7.03 doc says the M7.02 release step copies it, but `scripts/release` only writes the tarball. `dist/` is gitignored.
2. **Set the release identity and the Access variables at deploy.** None of these values are committed. Use placeholders in notes and never paste real values into the repo:
   - `RELEASE_ID` = the release id from `release.json`
   - `RELEASE_VERSION` = the version from `release.json`
   - `ACCESS_TEAM_DOMAIN` = `<team>.cloudflareaccess.com` (lower case)
   - `ACCESS_AUD` = `<access application audience tag>`
   - `ACCESS_ALLOWED_EMAIL` = `<owner email>`

   The committed `wrangler.jsonc` sets these to `unreleased`, `0.0.0` and empty strings. Until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, `/pair` refuses everyone. The `APP_ENV` variable is already `staging` in the config.
3. **Deploy from `deploy/staging`.** The form below is from M7.03. Add the Access variables the same way:

   ```sh
   wrangler deploy --var RELEASE_ID:<release id> --var RELEASE_VERSION:<version>
   ```

   The `v1` migration in `wrangler.jsonc` creates the `PairingStore` Durable Object on first deploy. Do not edit or renumber that migration.
4. **Record the Cloudflare version id** that `wrangler deploy` prints, next to the release.

### Verify

Check each item and write the result in the rehearsal log (section 8).

- **Signed out, the Access app stops the request.** `/`, a release asset (for example `/index.html` or a `.js` file), and `/v1/projects` should each redirect to the Access login. This redirect is done by the Access application at the hostname, not by the Worker. If the Access app is missing, the Worker itself answers `/v1/projects` with `401 unauthorized` and serves `/` and assets with no check at all. So the Access policy is the only protection for `/` and the assets.
- **Other URLs are off.** The `workers.dev` address and version preview URLs should not serve the app. The config sets `workers_dev: false` and `preview_urls: false`. S-3 expects 404 for them. Check the real hostname and every other reachable URL.
- **Signed in, pairing works.** Sign in through Access and open `/pair`. It redirects to `/#pair=<code>`, and the page exchanges the code for a session. The header should show the `STAGING` banner and `staging · <first 12 characters of the release id>`. Compare that id with `release.json`.
- **Pairing is one-use.** Reusing the same `/pair` code should fail. This is covered by the M7.04 browser check.

## 4. Backup and restore of a Taskville home

The home is `--home <dir>`, else `$TASKVILLE_HOME`, else `~/.taskville`. Source: `resolveHome` and `homePaths` in `apps/engine/src/config/home.ts`. The CLI accepts `--home` as a global option.

### What to back up

| File | What it is | Back up? |
| --- | --- | --- |
| `taskville.db` | The event log, projections, replay checkpoints, pairings (hashed secrets), and telemetry cost totals. | **Yes.** This is the state. |
| `taskville.db-wal`, `taskville.db-shm` | SQLite write-ahead log and shared memory, present while the engine runs or after a crash. | **Yes, if present.** Copy them with `taskville.db`. |
| `evidence.db` (and its `-wal`, `-shm`) | Tool-call input and output bodies, capped at 64 KB each. | **Yes.** |
| `config.json` | Optional user settings. | Yes, if present. |
| `token`, `bridge-token` | The CLI and telemetry token, and the permission-bridge token. Mode 0600. | **Treat as secrets.** Back up only with the same care as the database. |
| `spool/` | Hook posts the shim could not deliver. Ingested on the next start. | Yes, if it has files. |

Checkpoints are disposable caches inside `taskville.db`. Rebuilding them costs time, not data.

Claude Code's hook settings are written by `taskville install claude-code` outside the home. They are not part of this backup. Reinstall them with that command after a restore on a new machine if needed.

### Backup

1. **Stop the engine first.** Stop `taskville start` or `taskville serve --headless` with Ctrl-C. In a terminal, Ctrl-C stops the engine like SIGINT (`apps/cli/src/commands/serve.ts`). Copying a live database can capture a torn state. The code has no online backup command, and the repo does not verify a backup taken while the engine runs.
2. **Copy the files listed above** to a new folder with owner-only permissions. Copy the `-wal` and `-shm` files with the database they belong to.
3. Keep the copy with the release it came from. Note the release id, and the `taskville --version` output.

### Restore

1. Stop the engine.
2. Move the current home out of the way. Do not delete it until the restore is verified.
3. Put the backed-up files into a new home folder. Keep the folder and files private (the engine tightens them to 0700 and 0600 on start).
4. Start the engine with that home: `taskville start --home <dir>` (or set `TASKVILLE_HOME`). The engine migrates an older database forward and rebuilds projections (section 5).
5. Verify (below).

### Verify a restore

Source: the CLI usage lines in `apps/cli/src/main.ts`.

- `taskville doctor` checks Node, the web client, the engine, the hooks, the shim, curl and the project.
- `taskville project list` should show the projects you expect.
- `taskville status --project <id>` should show the agents of that project as a tree.
- Open the city in a browser (`taskville start`) and check one project's history.

`GET /health` needs the home's token. Send `Authorization: Bearer <token>`, with the token read from `<home>/token`. Without it the engine answers 401. The doctor's engine probe does the same (`engineHealthy` in `apps/cli/src/commands/doctor.ts`, which reports 401 or 403 as "rejected the token"). This was found in the local rehearsal (section 8).

A database integrity check beyond these is **not defined in this repo**. Use a SQLite tool only after confirming its availability and flags on your machine. This runbook does not give one.

**Restoring pairings:** `taskville unpair` revokes every paired browser. A restored database brings back the pairings it held when the backup was taken. If a browser was unpaired after that, unpair again after the restore.

## 5. Schema compatibility

What the code does, and where it does not say.

### Main database (`taskville.db`)

- **Forward-only migrations.** `apps/engine/src/storage/migrations.ts` holds an ordered list of migrations (currently V1 to V3). Each one is applied in order inside one `BEGIN IMMEDIATE` transaction. The applied version is recorded in `schema_migrations`. A shipped migration is never edited; a change is a new migration. There are no down migrations.
- **Older engine, newer database.** `migrate` throws `database schema version N is newer than this engine supports` before applying anything. The engine does not start, and nothing is changed. Go back to a backup taken before the newer release (section 6).
- **Newer engine, older database.** A newer engine applies the missing migrations on start, in order, and records each one.

### Evidence database (`evidence.db`)

- The version is `PRAGMA user_version`. The same rule applies: a newer version than the engine knows is refused (`evidence.db schema N is newer than this engine`).
- When the version is behind, the engine creates the current tables in one transaction. The current code has one step only (version 0 to the current version). **How a later evidence schema change is upgraded is not defined yet.** Treat any future evidence schema change as needing its own review.

### Projections and the reducer

- The domain reducer has a version, `REDUCER_VERSION`, in `packages/domain/src/reducer/index.ts` (currently 9).
- Each stored projection records the reducer version it was built with. At boot, `rebuildStaleProjections` (`apps/engine/src/stream/boot.ts`, `storage/rebuild.ts`) rebuilds any project whose projection has a different reducer version or lags the project head. The rebuild replays the event log in order and writes new checkpoints.
- So a reducer change is a **rebuild on upgrade**, not a data migration. The events are never rewritten. Checkpoints tagged with a different version are treated as missing and rebuilt.
- The rebuild happens before the HTTP server listens. A large log takes longer to boot.

### Where the behavior is not defined

- **Downgrade.** No downgrade path exists. An older engine refuses a newer schema, and nothing converts a database back.
- **Older engine, same schema, newer reducer.** The schema check passes, and the older engine rebuilds projections to its own reducer version at boot. A newer engine would rebuild them again on its next boot. The events are safe, but the code does not say this is intended, and this runbook has not tested it. Avoid running two versions against one home.
- **Event types and envelopes from a newer engine.** The code does not define how an older reducer handles events it does not know. Do not assume it is safe.
- **Client and protocol versions.** The runbook does not define which web client or CLI versions work with which engine. Ship and install the release as one tarball.
- **Storage across machines.** A home is local. Nothing in the repo syncs or merges two homes.

## 6. Rollback

### Staging

> **Held by decision #432 (2026-11-07).** Not rehearsed. The steps below are kept as written for when staging resumes.

1. Pick the previous release id from its folder (`<dir>/<previous id>/`) and its `release.json`.
2. Extract `package/web/` from its tarball into `deploy/staging/dist/`, as in section 3, step 1.
3. Redeploy with the previous `RELEASE_ID` and `RELEASE_VERSION`, using the same `wrangler deploy` form in section 3.
4. Verify section 3 again. Check the banner and the release id on the page.

Staging holds demo data and a pairing store. A redeploy keeps the pairing store, so paired sessions keep working unless revoked.

A `wrangler rollback` command to a previous Cloudflare version is mentioned in planning, but it is **not in this repo and not verified**. Confirm its syntax with the installed Wrangler before relying on it in the rehearsal. The redeploy above does not depend on it.

### Local (the published tarball)

1. Stop the engine.
2. Install the previous tarball into a prefix folder, then run the installed bin. The method is the one the clean-machine check uses (M7.28, #427, `tests/e2e/release/clean-install.ts`):

   ```sh
   npm install --prefix <prefix> <dir>/<previous id>/taskville-<version>.tgz --offline --no-audit --no-fund
   <prefix>/node_modules/.bin/taskville --version
   ```

   The bin is `<prefix>/node_modules/.bin/taskville`. Use the same `--home` (or `TASKVILLE_HOME`) as the upgraded home when you start it.
3. Check the version with `taskville --version`. It should show the previous release id.
4. Start the engine.

**What happens to a database that was migrated forward.** The older engine refuses it with a schema-version error and does not start. It does not change the database. To go back, restore the backup taken before the upgrade (section 4, restore).

So the rule for every local upgrade is: **stop the engine, back up the home, then install the new tarball.**

## 7. Promotion

Promotion publishes the exact reviewed tarball. Nothing is rebuilt.

### Preconditions

- The release was built from a clean tree (`dirty` is absent in `release.json`) with `--environment` set for its purpose.
- The release was reviewed by installing the tarball locally (section 6, Local) with the id matched to `taskville --version` (decision #432, D3). Staging review (section 3) is required once staging resumes.
- The **clean-machine install receipt** exists next to the release. It is written by `pnpm test:release:install <release-dir> --receipt <receipt.json>` (M7.28, #427, merged). Without it, the release is not promoted.
- The owner has asked for the publication. Publishing a release is a production action. Under the project's rules, agents do not close gates or promote without the owner.

### Steps

1. Take the three files from `<dir>/<release id>/`: `taskville-<version>.tgz`, `release.json` and `manifest.json`. Do not rebuild them.
2. Check the tarball's SHA-256 against `tarball.sha256` in `manifest.json`. Use a hash tool of your choice. The repo does not name one.
3. Publish the three files as a GitHub release for the version. The command or steps for that are **not in this repo** (the release publication script is not written yet).
4. Record the release id, the GitHub release URL, the tarball hash and the receipt in the release notes, and link them from the ticket.

## 8. Rehearsal log

The lead fills this in after each rehearsal. Each row is one run. While staging is held (decision #432), rehearsals are local, and staging rows stay empty until staging resumes.

| Date | Release id | Steps run | Result |
| --- | --- | --- | --- |
| 2026-11-07 | previous `38c0d20bcd1aa799` (7177eec), candidate `89110d8d2ea2a377` (60301c0) | local, scratch HOME/TASKVILLE_HOME/npm cache: tarball sha256 vs manifest (both match); install previous; serve and seed with `demo`; stop; back up (section 4); install candidate on the same home; doctor; rollback to previous on the upgraded home; restore the backup into a fresh home | pass: `status --json` byte-identical at backup, after upgrade, after rollback and after restore; `/health` showed each release id; restored home 0700, db and token 0600; doctor's hooks, shim and project checks fail by design in a scratch home. Not exercised: schema-refusal rollback (both releases share schema V3 and reducer 9), staging steps (held). Transcript: #85 comment |
