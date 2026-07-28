import { expect } from 'vitest'

// The arguments of a mock's first call, asserted to exist. Indexing straight into `mock.calls[0]` is
// an unchecked access — a type error under the repo's strict config, and at runtime a "cannot read
// properties of undefined" that names neither the mock nor the missing call. Asserting here fails on
// the real problem instead: the call never happened.
export function firstCall<Args extends unknown[]>(mock: { mock: { calls: Args[] } }): Args {
  const [call] = mock.mock.calls
  expect(call, 'expected the mock to have been called at least once').toBeDefined()
  return call as Args
}
