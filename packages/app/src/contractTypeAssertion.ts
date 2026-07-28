import type { components } from '@ratatoskr/contract'

// Compile-time assertion that contract types reach this package as real types, not `any`
// (SPEC section 12). The generated module behind @ratatoskr/contract's `components` re-export
// once never made it into the built package: the re-export resolved to nothing, every contract
// type here silently became `any`, and `skipLibCheck` swallowed the underlying error because it
// sits inside a .d.ts. Nothing was held to the contract by the compiler, and no build went red.
//
// Inverted on purpose — indexing a schema key that does not exist MUST be an error. Should the
// types collapse to `any` again, that error disappears, the directive below goes unused, and
// TS2578 fails the build. A TS2578 here is the alarm, not a lint nit: do not silence it by
// deleting the directive.
//
// Both halves of where this sits are load-bearing, so do not tidy the file elsewhere. It must be
// in a package that *consumes* @ratatoskr/contract, because the failure was that package's own
// boundary and only crossing it detects one. And it must be under src/, because tsconfig.json
// here sets `include: ["src"]` — anything in test/ is transpiled by vitest but never typechecked,
// which would disarm the assertion silently. The cost is an empty module in dist/ that no import
// reaches at runtime.
// @ts-expect-error - 'ThisDoesNotExist' must not resolve; that is precisely the assertion
export type ContractTypesAreReal = components['schemas']['ThisDoesNotExist']
