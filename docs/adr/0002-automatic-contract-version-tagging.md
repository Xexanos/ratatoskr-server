# Automatic contract version tagging: one version, one text, one immutable tag

Decided 2026-07. Every version of `contract/openapi.yaml` is frozen under an immutable
`contract-<x.y.z>` git tag, cut automatically the moment it lands on `main`; and a CI guard makes
`info.version` name the contract text one-to-one, so those tags are honest. This replaces the
previous practice of creating a `contract-*` tag by hand, only when a major had to be frozen.

## Context

The repo carries two independent version streams. The **server image** is tagged `v<x.y.z>` by
`promote.yml`, derived from Conventional Commits and cut only after E2E passes — a version tag can
never point at unvalidated bytes. The **contract** is versioned by `info.version` in
`contract/openapi.yaml` and, separately, by `contract-<x.y.z>` git tags.

Only one contract tag existed — `contract-1.4.0`, created by hand when `/v2` work began, to freeze
the outgoing `/v1` surface. Two things consume such a tag: the Android app pins the server repo as a
submodule at a `contract-*` tag to generate its client types, and a superseded major is served
frozen directly from its tag — the tag *is* the freeze, with no second contract file (ADR-0001).
Both treat the tag as *the* definition of a contract version, so "the tag is the contract text" is a
load-bearing property, not a formality.

Two facts made the manual practice fragile:

- **`info.version` did not track the contract text.** oasdiff fails only *breaking* changes made
  without a major bump; a backwards-compatible addition (a new optional field, an extra declared
  response) passes green without touching `info.version`. The history shows this plainly — `1.1.0`,
  `1.2.0`, `1.3.0` and `2.0.0` each span several contract-editing commits. A version was a moving
  label over a range of texts, not a name for one.
- **The current version was never tagged.** Because tags were cut only at a freeze, the version under
  active development — the one a client most wants to pin against — had no tag at all.

## Decision

**Eager tagging, made honest by a bump guard.** The invariant: *a contract version names exactly one
contract text, and every version on `main` carries its immutable tag.* Two mechanisms uphold it,
split by trigger and role rather than by topic (mirroring how `oasdiff` lives in `ci.yml` while
release mechanics live in `promote.yml`):

- **`contract-version` (guard), a job in `ci.yml`** — runs on every PR, unfiltered, so it is safe as
  a required status check (an unchanged contract passes in the first step, rather than a path filter
  leaving a required check forever pending — the trap documented in `container.yml`). When the
  `contract/openapi.yaml` blob differs from the PR base, `info.version` on the head must be a plain
  `x.y.z`, strictly greater than base, and not already a tag. Strict-greater gives monotonicity over
  all of `main` by induction, so no number can ever recur — not even an untagged historical one. The
  *height* of a compatible bump (minor vs patch) is left to human judgement: automating it would
  duplicate oasdiff's classification for little gain, and breaking→major is already forced by oasdiff.
- **`contract-tag.yml` (tagger), its own workflow** — on push to `main` filtered to
  `contract/openapi.yaml`, plus `workflow_dispatch` for manual healing; `contents: write`. It ensures
  the tag: absent → create the annotated `contract-<version>` on `HEAD` and push; present → compare
  the tagged blob to `HEAD` and fail if they differ. It cannot live in `ci.yml`: `on.push.paths`
  filters at the workflow level and would gate the whole of CI on contract pushes.

**Cut on push, not gated on a green run.** The two tag kinds assert different things. `v1.6.0`
certifies "these bytes passed E2E" and must hang behind validation. `contract-2.1.0` is an *identity*
statement — "this is the byte-exact text of version 2.1.0" — which no test makes truer; its consumers
(a client generating types, a frozen major served from the tagged text) never ask whether the server
runs. The validation a contract tag
does need (the bump guard, oasdiff) has already run on the PR. Gating on CI would also couple the tag
to the deliberately unpinned `abs-latest` integration leg, whose job is to go red on upstream drift —
an identity tag blocked by someone else's release is the wrong coupling.

**The tagger is idempotent and self-healing.** Re-running is a no-op when the tag already matches, and
the blob comparison is a backstop: if a contract is ever edited in place under an existing version
(e.g. an admin bypass of branch protection that skips the guard), the tagger goes red instead of
silently accepting drift — the honesty of the tag is a property of the branch, not merely of a
proposed change to it.

**No backfill.** Historical `1.x` versions get no tags: `/v1` clients pin `contract-1.4.0`, the freeze
needs only that one, and no one will build against `1.2.0` again. `2.0.0` currently lives on a feature
branch; when it merges after this pipeline, the merge tags `contract-2.0.0` on its own.

## Considered options

- **Freeze-on-supersede (rejected)** — auto-tag a major only when a *new* major appears, automating
  exactly the manual `1.4.0` step. Rejected because it only ever tags the *outgoing* major and never
  gives the current one a tag to pin against — the very gap that motivated this.
- **Explicit human intent (rejected)** — tag on a label or a manual dispatch, "this version is done."
  A reasonable model *if* a version were edited in place until finished. We chose the opposite: with
  the bump guard, a version is sealed the moment it lands, so there is nothing to later declare done.
- **Minimal guard — "changed ⇒ unequal" (rejected)** in favour of strict-greater + not-yet-tagged.
  Mere inequality lets a number go backwards or reuse an untagged historical one, which would make a
  later tag lie about which text it names.

## Consequences

- **Every contract PR now costs a version bump — including a review fixup.** A second commit that
  touches the contract within a PR must carry the version forward (a `429` declared as an
  afterthought would have to become `2.0.1`). Commits *within* one PR may still share a version; the
  guard checks base→head, and the tag is cut from the state on `main`. This is the deliberate price
  of retiring in-place editing.
- **`contract-version` must be added as a required status check** to the `protect main` ruleset;
  otherwise the guard is advisory and a bump can be skipped.
- Tags are pushed with `GITHUB_TOKEN`, which does not trigger further workflows — no loops.
