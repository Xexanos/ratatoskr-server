# Ratatoskr server

Authoritative context lives in two files — read them before doing anything:
- `docs/SPEC.md` — goal, scope, architecture, decisions, constraints.
- `contract/openapi.yaml` — the single source of truth for the client/server API.

Working agreements:
- The OpenAPI contract is authoritative. Do not change it without following the
  versioning rules in SPEC section 6.
- Audiobookshelf is the single source of truth for progress. No database.
- Technology stack and module layout are still open — propose, discuss, then update SPEC.
- Commit messages follow Conventional Commits (`type(scope): subject`; enforced on PRs
  by the commitlint job in ci.yml, rules in commitlint.config.mjs) — the release
  pipeline derives the image's semver from them at promotion (see `promote.yml` and
  docs/deploy.md): `feat!:` / `BREAKING CHANGE:` footer → major, `feat:` → minor,
  `fix:` / `perf:` → patch; every other type (`docs:`, `chore:`, `ci:`, `refactor:`,
  `test:`, ...) cuts no release. PRs are merge-committed, so the *individual* commits
  on the branch are what count, not the PR title — pick each commit's type as if it
  alone decided whether operators get a new version.