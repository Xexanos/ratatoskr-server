// Pure, I/O-free position mapping and playback/seek planning (SPEC section 4). Zero runtime
// dependencies by design (SPEC section 13; enforced by test/purity.test.ts and the ESLint
// import boundary).
export { absoluteToTrack, totalDuration, trackToAbsolute, type TrackPosition } from './positionMapper.js'
export { planPlayback, type TrackInput, type PlannedTrack, type PlaybackPlan } from './playbackPlan.js'
export { planSeek, type SeekTuning, type SeekStep, type SeekPlan } from './seekPlan.js'
