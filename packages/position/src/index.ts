// Pure, I/O-free position mapping and (later) seek planning (SPEC section 4). Zero runtime
// dependencies by design (SPEC section 13; enforced by test/purity.test.ts and the ESLint
// import boundary).
export { absoluteToTrack, totalDuration, trackToAbsolute, type TrackPosition } from './positionMapper.js'
