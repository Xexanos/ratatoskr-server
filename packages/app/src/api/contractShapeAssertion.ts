import type { components } from '@ratatoskr/contract'
import type { LibraryBook, LibraryBookDetail, LibraryBookPage } from '../abs/library.js'
import type { PlaybackSession } from '../playback/sessionManager.js'

// Compile-time assertions that the domain library shapes cannot be handed to a caller expecting the
// contract's, i.e. that skipping api/contractMapping.ts is a build failure rather than a plausible
// but wrong URL on the wire.
//
// This needs asserting because the incompatibility is not self-evident from the types. The contract
// marks coverUrl, author, progress and Session.item all OPTIONAL, so "the domain carries hasCover
// where the contract carries coverUrl" does not on its own stop the assignment — TypeScript is
// structural and tolerates extra properties on anything but a fresh object literal. What actually
// blocks it is that the domain states "not known" as an explicit `undefined` while the contract
// states it by omitting the property, which `exactOptionalPropertyTypes` (tsconfig.base.json) makes
// incompatible. (LibraryBookPage is the one exception: it says `books` where the contract requires
// `items`, so it fails on a missing required property regardless of that flag.)
//
// That is a real distinction and the right one to model, but it is load-bearing in a way a reader
// would not guess, and it lives in a file (abs/library.ts) that has no reason to mention the
// contract at all. Hence these assertions: should the shapes ever drift back into compatibility — an
// optional marker "tidied" onto a domain field, exactOptionalPropertyTypes switched off — the
// Rejects<> constraint below is violated and the build goes red at this line.
//
// Deliberately a positive assertion rather than a @ts-expect-error on a deliberately-bad assignment
// (contractTypeAssertion.ts has to use the latter, because the thing it pins is an error). An
// inverted directive would be the weaker choice here: `A extends B ? ... : ...` is a conditional
// type and never errors, so the directive would sit permanently unused, and a directive that reports
// TS2578 both when the invariant breaks and when it is merely rephrased is a poor alarm.

// Resolves to the type only if `Domain` is NOT assignable to `Contract`; otherwise `false`, which
// violates the `extends true` constraint and fails the build at the use site.
type Rejects<Domain, Contract> = [Domain] extends [Contract] ? false : true
type Assert<T extends true> = T

export type BookIsNotASummary = Assert<Rejects<LibraryBook, components['schemas']['LibraryItemSummary']>>
export type DetailIsNotAnItem = Assert<Rejects<LibraryBookDetail, components['schemas']['LibraryItem']>>
export type PageIsNotAContractPage = Assert<Rejects<LibraryBookPage, components['schemas']['LibraryItemPage']>>
export type SessionIsNotAContractSession = Assert<Rejects<PlaybackSession, components['schemas']['Session']>>
