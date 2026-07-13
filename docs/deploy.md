# Deployment & container publishing — ratatoskr-server

The server ships as a single, multi-arch container image (SPEC section 12). This document
covers building and running it, and the CI flow that publishes a **testing** image for the
central E2E stack and **promotes** it to a release channel only after E2E passes.

## The image

- **Dockerfile:** [`Dockerfile`](../Dockerfile) at the repo root. Multi-stage: a build stage
  installs the pnpm workspace, generates the contract artifacts, compiles TypeScript, and runs
  `pnpm deploy` to emit a self-contained production tree of `@ratatoskr/app` (its `dist` plus a
  flat, production-only `node_modules` with the workspace deps injected as built code). The
  runtime stage is a slim `node:22-alpine`, runs as the non-root `node` user, and starts the
  one process (`node dist/main.js`).
- **Build context is the repo root** (the app is a workspace package):
  ```sh
  docker build -t ratatoskr-server .
  ```
- **Configuration** is entirely via environment variables — documented inline in
  [`compose.yaml`](../compose.yaml) (the operator reference) and SPEC section 7. `ABS_URL` and
  `ABS_STREAMER_API_KEY` are required; for the listener transport, the container auto-generates a
  self-signed certificate unless you set `TLS_CERT_PATH`/`TLS_KEY_PATH` or `ALLOW_PLAIN_HTTP=true`
  (see "TLS" in the README). Invalid config is reported (all problems at once) and the container
  exits non-zero at startup.
- **Health:** the image's `HEALTHCHECK` is a raw TCP connect to `PORT` (liveness only — works
  for both HTTP and HTTPS). Application health, including ABS/Sonos reachability, is the
  unauthenticated `GET /v1/health` endpoint.
- **Shutdown:** `SIGTERM` (what `docker stop` sends) triggers the graceful drain (SPEC section 5)
  — the active session's reached position is written back to ABS before exit.

### Running

Operators deploy with the single [`compose.yaml`](../compose.yaml) (see the README) — no repository
checkout required. Sonos discovery and UPnP eventing need the host LAN, so it runs with host
networking; where that is not possible, switch to the bridge block and set `SONOS_SEED_HOST` (SPEC
section 12, "Container networking"). For a quick manual run without compose:

```sh
docker run --rm --network host \
  -e ABS_URL=https://abs.lan:13378 \
  -e ABS_STREAMER_API_KEY=... \
  -v "$PWD/tls:/tls" \
  ghcr.io/xexanos/ratatoskr-server:latest
```

With no TLS variables set, the entrypoint generates a persistent self-signed certificate in the
mounted `/tls` and serves HTTPS (fingerprint logged for the app's trust-on-first-use).

## Publishing pipeline

Two workflows implement a **build → E2E → promote** flow. The guiding principle: the image
that gets released is the *exact* image that passed E2E — promotion re-tags the tested bytes,
it never rebuilds.

```
 push to main / manual dispatch
            │
            ▼
 ┌───────────────────────────┐   pushes    ghcr.io/xexanos/ratatoskr-server:testing-<sha>
 │ container.yml (build job)  │───────────► (multi-arch: linux/amd64, linux/arm64)
 └───────────────────────────┘             also tagged sha-<full-sha> (immutable digest handle)
            │ repository_dispatch (event_type: server-image)
            │ payload: { image, tag, digest, sha }
            ▼
 ┌───────────────────────────┐   pulls testing-<sha> + fake-sonos + ABS, runs the full suite
 │ ratatoskr-e2e (other repo) │
 └───────────────────────────┘
            │ on green: repository_dispatch (event_type: e2e-passed)
            │ payload: { digest, channels?, version? }
            ▼
 ┌───────────────────────────┐   re-tags the TESTED digest (no rebuild) to the channel(s),
 │ promote.yml (promote job)  │───────────► e.g. :latest, :stable, :<version>
 └───────────────────────────┘
```

### 1. `container.yml` — build & publish the testing image

- **Triggers:** `push` to `main` and `workflow_dispatch` (build + push + trigger E2E);
  `pull_request` (build both arches as a bitrot guard, **no push**).
- **Publishes:** `ghcr.io/xexanos/ratatoskr-server:testing-<short-sha>` (the E2E artifact) and
  `sha-<full-sha>` (an immutable handle for digest-based promotion), multi-arch.
- **Then:** dispatches `event_type: server-image` to `Xexanos/ratatoskr-e2e` with the image ref
  and digest, so E2E runs against exactly this build.

To hand the **current feature branch** to E2E before merging, run the workflow manually:

```sh
gh workflow run container.yml --ref <your-branch>
```

### 2. `promote.yml` — publish a tested image to a release channel

- **Triggers:** `repository_dispatch` (`event_type: e2e-passed`, fired by the E2E repo on a
  green run) and `workflow_dispatch` (manual promotion of a known-good tag/digest).
- **What it does:** `docker buildx imagetools create` copies the multi-arch manifest addressed by
  the tested **digest** under the requested channel tag(s) — a pure server-side re-tag, so what
  ships is provably what E2E validated. Default channel is `latest`; an optional `version` input
  adds an immutable `:<version>` tag.

Manual promotion example:

```sh
gh workflow run promote.yml -f source=sha256:<tested-digest> -f channels=latest,stable -f version=1.2.3
```

### 3. `registry-cleanup.yml` — prune throwaway images

Every build publishes two tags onto the same manifest — `testing-<sha>` and `sha-<full-sha>` —
so without cleanup GHCR fills up. A scheduled job prunes both (they are the disposable identity
of one commit's build) once older than **14 days**, keeping the **3 most recent** as a safety
floor and never touching promoted channels (`latest`, `stable`).

- **Triggers:** daily cron, plus `workflow_dispatch` with a `dry-run` input to preview.
- **How:** [`dataaxiom/ghcr-cleanup-action`](https://github.com/dataaxiom/ghcr-cleanup-action),
  which understands multi-arch manifest lists — it removes the untagged per-platform child
  manifests along with each deleted image and leaves nothing orphaned. (A hand-rolled
  delete-by-tag would either strand child layers or delete a manifest a co-located release tag
  still points at.)

Preview what a run would remove, without deleting:

```sh
gh workflow run registry-cleanup.yml -f dry-run=true
```

## One-time setup

- **`E2E_DISPATCH_TOKEN` secret** (in this repo): a token that can dispatch to
  `Xexanos/ratatoskr-e2e` — the per-run `GITHUB_TOKEN` is scoped to this repo only, so it cannot
  reach across. Absent this secret, `container.yml` still builds and pushes `testing-<sha>` and
  simply logs a notice instead of triggering E2E. A fine-grained PAT (or GitHub App token) with
  *Contents: read/write* (or *Actions*) on the E2E repo, restricted to that repo, is enough.
- **`GHCR_CLEANUP_TOKEN` secret** (optional, for `registry-cleanup.yml`): the injected
  `GITHUB_TOKEN` can delete versions of a package owned by an **organization**, but for a
  **user-owned** package it may lack delete rights. If the cleanup job fails to delete, add a
  classic PAT with `read:packages` + `delete:packages` as this secret; the job uses it in
  preference to `GITHUB_TOKEN`. Verify safely first with `gh workflow run registry-cleanup.yml -f dry-run=true`.
- **Package visibility:** the first push creates the GHCR package private. For
  `Xexanos/ratatoskr-e2e` to pull it, either make the package **public** (Package settings →
  Change visibility) or grant that repo read access (Package settings → Manage Actions access →
  add the E2E repo). Pulls in the E2E workflow authenticate with its own `GITHUB_TOKEN`.
- **E2E-side callback:** on a successful run, the E2E workflow promotes the image it just tested:
  ```yaml
  # in Xexanos/ratatoskr-e2e, after the E2E job succeeds
  - name: Promote the tested server image
    if: success()
    env:
      GH_TOKEN: ${{ secrets.SERVER_PROMOTE_TOKEN }}   # can dispatch to ratatoskr-server
    run: |
      gh api repos/Xexanos/ratatoskr-server/dispatches \
        -f event_type=e2e-passed \
        -F client_payload[digest]="${{ github.event.client_payload.digest }}" \
        -F client_payload[channels]=latest
  ```
