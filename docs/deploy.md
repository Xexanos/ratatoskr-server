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

Operators deploy with the single [`compose.yaml`](../compose.yaml) — download it, set `ABS_URL`
and `ABS_STREAMER_API_KEY` in its `environment:` block, and `docker compose up -d` (full walkthrough
in the [README](../README.md#running-with-docker)). No repository checkout required. Sonos discovery
and UPnP eventing need the host LAN, so it runs with host networking; where that is not possible,
switch to the bridge block and set `SONOS_SEED_HOST` (SPEC section 12, "Container networking").

With no TLS variables set, the entrypoint generates a persistent self-signed certificate in the
`./tls` volume and serves HTTPS (fingerprint logged for the app's trust-on-first-use).

### Running on TrueNAS SCALE

Since TrueNAS SCALE 24.10 ("Electric Eel") apps run on Docker, so the server deploys as a
**custom app** — no catalog entry needed. Two equivalent routes, both ending up as the same kind
of app with the same update behavior:

- **Install via YAML** (*Apps → Discover Apps → ⋮ → Install via YAML*): paste
  [`compose.yaml`](../compose.yaml) with two adjustments — set the required variables, and replace
  the `./tls` bind mount with a named volume (add `ratatoskr-tls: {}` under a top-level `volumes:`
  and mount it as `ratatoskr-tls:/tls`) or an absolute dataset path.
- **Install Custom App** (form): image repository `ghcr.io/xexanos/ratatoskr-server`, tag
  `latest`, restart policy *Unless Stopped*, environment variables `ABS_URL` and
  `ABS_STREAMER_API_KEY`, and a storage mount for `/tls`.

Notes that apply either way:

- **Enable Host Network** — SSDP multicast discovery and UPnP eventing need the host LAN (SPEC
  section 12). Port mapping is disabled under host networking; the server listens on port 8080 of
  the NAS directly (set `PORT` if that clashes).
- **Persist `/tls`, and make it writable.** Without it the auto-generated certificate — and with
  it the fingerprint the app pinned on first use — changes on every container recreation. The
  startup error `cannot write to /tls` means the mount's owner and the container's user disagree;
  the image runs under any uid (its `USER 1000:1000` is just the default), so align them either
  way:
  - **Named volume** (YAML route): inherits writable ownership from the image — works as-is.
  - **ixVolume** (form): created **root-owned**, so no container user can write to it out of the
    box. In the volume's config, check *Enable ACL* and add an ACL entry for the uid the
    container runs as (ID Type *User*, ID `1000` — or `568` if you set *Custom User* — with
    *Modify* access). Equivalent alternative: a one-time
    `chown -R <uid>:<gid> /mnt/.ix-apps/app_mounts/<app>/<volume>` from the NAS shell, though the
    ACL lives in the app config and is re-applied on redeploy. Once the volume contains data
    (i.e. after the first successful start), also check the ACL's **Force Flag** — TrueNAS
    otherwise rejects every later app edit with `path contains existing data and 'force' was not
    specified`; the flag only permits applying the ACL to a non-empty directory, the contents are
    untouched. (Images released before the entrypoint's write-probe fix refuse ACL-only grants —
    their writability check read plain mode bits — so on an older image use `chown`.)
  - **Host path** on a dataset: `chown` it to whatever uid the container runs as (`1000:1000` by
    default).
- **Updates:** TrueNAS watches the `latest` digest and shows *Update available* in the Apps
  screen; applying it is one click but not automatic. For unattended updates, schedule a tool such
  as [truenas-auto-update](https://github.com/marvinvr/truenas-auto-update).
- The custom-app form exposes no stop grace period; Docker's default 10 s stop timeout still
  exceeds the graceful drain (`SHUTDOWN_TIMEOUT_MS`, default 5000), so the reached position is
  written back to ABS on stop as usual.
- The certificate's SHA-256 fingerprint for the app's trust-on-first-use is in the app's log
  (*Apps → ratatoskr → View Logs*).
- **Pre-install security screen:** both checks it can raise are addressed — the image declares a
  numeric non-root user (`USER 1000:1000`), and [`compose.yaml`](../compose.yaml) sets
  `no-new-privileges` (picked up by the YAML route; the custom-app *form* has no field for
  `security_opt`, so that finding stays informational there and is safe to accept).

## Publishing pipeline

Two workflows implement a **build → E2E → promote** flow. The guiding principle: the image
that gets released is the *exact* image that passed E2E — promotion re-tags the tested bytes,
it never rebuilds.

![Publishing pipeline: a push to main (or manual dispatch) runs container.yml, which builds and
pushes the multi-arch testing-<sha> image; a repository_dispatch (server-image) runs the full E2E
suite in ratatoskr-e2e against the server plus fake-sonos and Audiobookshelf; on a green run a
repository_dispatch (e2e-passed) runs promote.yml, which re-tags the tested digest to :latest /
:stable / :<version> without rebuilding. A legend maps the colors: green = trigger, blue =
ratatoskr-server workflow, purple = ratatoskr-e2e repo, gray pill = cross-repo repository_dispatch.](pipeline.svg)

### 1. `container.yml` — build & publish the testing image

- **Triggers:** `push` to `main` and `workflow_dispatch` (build + push + trigger E2E);
  `pull_request` (build both arches as a bitrot guard, **no push**; path-filtered so docs-only PRs
  skip it).
- **Publishes:** `ghcr.io/xexanos/ratatoskr-server-testing:testing-<short-sha>` (the E2E artifact),
  multi-arch, in a **private** package. Throwaway per-commit images stay here; the public release
  package (`ratatoskr-server`) only ever receives promoted images (see `promote.yml`). That one tag
  identifies the commit; the full SHA is also recorded in the image's
  `org.opencontainers.image.revision` label. Promotion addresses the tested image by **digest**, so
  no second sha tag is needed.
- **Then:** dispatches `event_type: server-image` to `Xexanos/ratatoskr-e2e` with the image ref
  and digest, so E2E runs against exactly this build. If the `E2E_DISPATCH_TOKEN` secret is missing,
  the job **fails** (a silently un-run E2E gate would be worse than a red pipeline).

To hand the **current feature branch** to E2E before merging, run the workflow manually:

```sh
gh workflow run container.yml --ref <your-branch>
```

### 2. `promote.yml` — publish a tested image to a release channel

- **Triggers:** `repository_dispatch` (`event_type: e2e-passed`, fired by the E2E repo on a
  green run) and `workflow_dispatch` (manual promotion of a known-good tag/digest).
- **What it does:** `docker buildx imagetools create` copies the multi-arch manifest addressed by
  the tested **digest** — **from the private `ratatoskr-server-testing` package into the public
  `ratatoskr-server` package** — under the requested channel tag(s). A pure server-side copy of the
  tested bytes (no rebuild), so what ships is provably what E2E validated. Default channel is
  `latest`.
- **Automatic semver versioning:** the workflow reads the promoted commit from the image's
  `org.opencontainers.image.revision` label and derives the next version from the
  **Conventional Commits** since the last `v*` tag: `feat!:` / `BREAKING CHANGE:` → major,
  `feat:` → minor, `fix:` / `perf:` → patch. Anything else (`docs:`, `chore:`, `ci:`,
  `refactor:`, …) cuts **no** version — the promotion then only moves the channel tags. When a
  version is cut, the image additionally gets an immutable `:<x.y.z>` tag and the commit gets a
  `v<x.y.z>` git tag plus a GitHub release with generated notes. Versioning happens **at
  promotion** (not on push to `main`) so a version tag can only ever point at a commit whose
  image passed E2E. Re-promoting an already-released commit (e.g. to `stable`) reuses its
  existing version; a commit already contained in a newer release gets no new version
  (out-of-order E2E completions). Note the promoted *image* carries no version label inside —
  promotion never rebuilds, so the version exists only as registry tag / git tag; the
  `revision` label is the stable link back to the commit.
- The `version` input overrides the automatism (publishes that image tag verbatim; no git tag).

Manual promotion example (auto-versioned; add `-f version=1.2.3` to override):

```sh
gh workflow run promote.yml -f source=sha256:<tested-digest> -f channels=latest,stable
```

### 3. `registry-cleanup.yml` — prune throwaway images

Every build publishes a `testing-<sha>` tag to the private `ratatoskr-server-testing` package, so
without cleanup GHCR fills up. A scheduled job prunes those once older than **14 days**, keeping the
**3 most recent** as a safety floor. It targets **only** the testing package; the public release
package (`ratatoskr-server`) holds solely promoted tags and is never touched (release channels stay
in `exclude-tags` as defense-in-depth, though the testing package never carries them).

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

## The fake Sonos image (test-only)

The E2E stack also needs the fake Sonos double (`packages/fake-sonos`) as a GHCR image
(ratatoskr-e2e test-concept.md §4/§6). It is published by its own workflow,
[`fake-sonos.yml`](../.github/workflows/fake-sonos.yml) — **not** by `container.yml`.

The key decision: the fake is a **slowly-changing test dependency**, so it is decoupled from the
server's per-commit build cadence. Rebuilding an identical fake on every server commit would just
burn CI and churn the registry. Instead:

- `fake-sonos.yml` is **path-filtered** to `packages/fake-sonos/**` (and `tsconfig.base.json`,
  which its Dockerfile copies). It runs only when the fake itself changes: a bitrot build on
  matching PRs, and on push to `main` it pushes `ghcr.io/xexanos/ratatoskr-fake-sonos` as
  `latest` (what E2E tracks) plus `sha-<short-sha>` (an immutable handle), multi-arch.
- The **E2E repo tracks the fake's `:latest`** by default (a digest can be pinned for a fully
  reproducible run and bumped deliberately), so it never needs a fake tag per server commit. Note
  the flip side: the server and fake are **not automatically co-tested**. `container.yml`'s
  `trigger-e2e` fires as soon as the server image is pushed, and that E2E run uses whatever fake
  `:latest` currently resolves to — so a commit that changes *both* server and fake must let
  `fake-sonos.yml` publish the new `:latest` first for the two to be tested together (otherwise the
  new server is validated against the previous fake). Closing that gap mechanically — e.g. this
  workflow sending a `repository_dispatch` with the new digest to the E2E repo, mirroring
  `trigger-e2e` — is a possible future enhancement, deliberately left out here to keep the fake
  decoupled from the server's cadence.
- The fake is **test-only and never promoted** to a release channel (only the server image is).
  Its tags are low-volume, so `registry-cleanup.yml` deliberately does not prune this package.

## One-time setup

- **`E2E_DISPATCH_TOKEN` secret** (in this repo): a token that can dispatch to
  `Xexanos/ratatoskr-e2e` — the per-run `GITHUB_TOKEN` is scoped to this repo only, so it cannot
  reach across. This secret is **required** for the pipeline: without it, `container.yml` builds and
  pushes `testing-<sha>` but the `trigger-e2e` job then **fails** rather than silently skipping the
  E2E gate. A fine-grained PAT (or GitHub App token) with *Contents: read/write* (or *Actions*) on
  the E2E repo, restricted to that repo, is enough.
- **`GHCR_CLEANUP_TOKEN` secret** (optional, for `registry-cleanup.yml`): the injected
  `GITHUB_TOKEN` can delete versions of a package owned by an **organization**, but for a
  **user-owned** package it may lack delete rights. If the cleanup job fails to delete, add a
  classic PAT with `read:packages` + `delete:packages` as this secret; the job uses it in
  preference to `GITHUB_TOKEN`. Verify safely first with `gh workflow run registry-cleanup.yml -f dry-run=true`.
- **Package visibility:** the first push creates each GHCR package private. Set them up once
  (GHCR is per-package, not per-tag):
  - **`ratatoskr-server`** (release, end-user facing): make it **public** (Package settings →
    Change visibility). It only ever holds promoted `:latest` / `:vX` images.
  - **`ratatoskr-server-testing`** and **`ratatoskr-fake-sonos`** (consumed by E2E): the E2E repo
    must be able to pull them — either keep them private and grant `Xexanos/ratatoskr-e2e` read
    access (Package settings → Manage Actions access → add the repo), or make them public if you
    don't mind throwaway/test images being visible. Pulls in the E2E workflow authenticate with
    its own `GITHUB_TOKEN` (or a `read:packages` PAT).
- **E2E-side callback:** on a successful run, the E2E workflow promotes the image it just tested:
  ```yaml
  # in Xexanos/ratatoskr-e2e, after the E2E job succeeds
  - name: Promote the tested server image
    if: success()
    env:
      GH_TOKEN: ${{ secrets.SERVER_PROMOTE_TOKEN }}   # can dispatch to ratatoskr-server
      PAYLOAD_DIGEST: ${{ github.event.client_payload.digest }}
    run: |
      # Reference the payload as a shell variable, never interpolate ${{ }} into the script:
      # a ${{ }} expands before the shell parses the line, so a crafted digest could inject
      # commands (with SERVER_PROMOTE_TOKEN in scope). Map it into env: and use "$PAYLOAD_DIGEST".
      gh api repos/Xexanos/ratatoskr-server/dispatches \
        -f event_type=e2e-passed \
        -F "client_payload[digest]=$PAYLOAD_DIGEST" \
        -F client_payload[channels]=latest
  ```
