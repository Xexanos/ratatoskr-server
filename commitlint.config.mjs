// Commit types are load-bearing here: promote.yml derives the release version from them
// at promotion (feat!/BREAKING CHANGE -> major, feat -> minor, fix/perf -> patch, anything
// else -> no release). CI enforces this shape on every PR commit (ci.yml "commitlint" job);
// see CLAUDE.md and docs/deploy.md.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // The standard types plus this repo's established ones — all of the extras are
    // release-neutral (promote.yml only acts on feat/fix/perf/breaking).
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
        // repo-specific:
        'deps', // dependency bumps (dependabot's configured prefix); use fix(deps): when a runtime bump should ship a release
        'review', // addressing PR review feedback
        'contract', // contract/openapi.yaml changes (versioned per SPEC section 6)
        'spec', // docs/SPEC.md changes
        'comment', // comment-only corrections
      ],
    ],
    // Style rules relaxed for dependabot, which capitalizes subjects ("deps: Bump ...")
    // and writes long changelog URLs into bodies. The gate exists so the TYPE parses —
    // subject cosmetics are not what the release pipeline reads.
    'subject-case': [0],
    'body-max-line-length': [0],
    // Dependabot subjects (scoped package + path) routinely exceed the 100-char default.
    'header-max-length': [0],
  },
}
