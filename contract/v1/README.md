# Frozen /v1 contract — do not edit

`openapi.yaml` in this directory is contract **1.4.0**, the surface Ratatoskr serves under
`/v1` during the transition window to the `/v2` auth model
([ADR-0001](../../docs/adr/0001-client-auth-ratatoskr-native-sessions.md), decided in
[#128](https://github.com/Xexanos/ratatoskr-server/issues/128)). Installed app versions
talk to it, so it is frozen: **no change of any kind belongs in this file**, not a typo fix
and not a reformat.

The freeze is enforced, not asked for. The `contract-freeze` job in `.github/workflows/ci.yml`
compares this file byte-for-byte against the `contract-1.4.0` git tag and fails the build on
any difference, so a repo-wide sweep cannot quietly reshape a surface that shipped.

`../openapi.yaml` — one directory up, the only file at that level — remains the single source
of truth for the API under development (SPEC section 6). Changes go there.

When `/v1` reaches the sunset described in ADR-0001, this whole directory is deleted together
with the rest of the `/v1` machinery.
