import type { components } from '@ratatoskr/contract'
import type { LibraryBook, LibraryBookDetail, LibraryBookPage } from '../abs/library.js'
import type { PlaybackSession } from '../playback/sessionManager.js'

// Compile-time assertions that the domain shapes cannot be handed to a caller expecting the
// contract's — i.e. that skipping contractMapping.ts is a build failure, not a wrong URL on the wire.
//
// Worth pinning because the incompatibility is not self-evident. The contract marks coverUrl, author,
// progress and Session.item all OPTIONAL, so "the domain carries hasCover where the contract carries
// coverUrl" does not by itself block the assignment: TypeScript is structural and tolerates extra
// properties on anything but a fresh object literal. What blocks it is that the domain states "not
// known" as an explicit `undefined` where the contract omits the property, which
// `exactOptionalPropertyTypes` (tsconfig.base.json) makes incompatible. Should that erode — an
// optional marker "tidied" onto a domain field, or the flag switched off — the constraint below is
// violated and the build goes red here.
//
// A positive assertion rather than a @ts-expect-error on a deliberately-bad assignment (the idiom in
// contractTypeAssertion.ts at src/contractTypeAssertion.ts, which pins an error and so has no
// choice). Here an inverted directive would be strictly worse: `A extends B ? … : …` is a conditional
// type that never errors, so the directive would sit permanently unused.

// Resolves to `true` only if `Domain` is NOT assignable to `Contract`; otherwise `false`, which
// violates Assert's constraint and fails the build at the use site.
type Rejects<Domain, Contract> = [Domain] extends [Contract] ? false : true
type Assert<T extends true> = T

export type BookIsNotASummary = Assert<Rejects<LibraryBook, components['schemas']['LibraryItemSummary']>>
export type DetailIsNotAnItem = Assert<Rejects<LibraryBookDetail, components['schemas']['LibraryItem']>>
// This one holds without the flag's help: the domain says `books` where the contract requires `items`.
export type PageIsNotAContractPage = Assert<Rejects<LibraryBookPage, components['schemas']['LibraryItemPage']>>
export type SessionIsNotAContractSession = Assert<Rejects<PlaybackSession, components['schemas']['Session']>>
