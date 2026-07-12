import { FakeSonos } from './fakeSonos.js'

// Standalone entrypoint for the container image the central E2E repo consumes. In-process
// consumers import FakeSonos directly; this wraps the same double for `node dist/main.js`.
//
// Configuration (env):
//   PORT           listen port                          (default 1400)
//   BIND_HOST      bind address                         (default 0.0.0.0)
//   ADVERTISE_HOST host advertised in the zone-group Location URL (default: BIND_HOST)
//   SPEAKER_UUID   speaker id, RINCON_…                 (default from FakeSonos)
//   ROOM_NAME      zone name                            (default from FakeSonos)

const port = Number(process.env.PORT ?? 1400)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`invalid PORT: ${process.env.PORT}`)
  process.exit(1)
}

const fake = new FakeSonos({
  host: process.env.BIND_HOST ?? '0.0.0.0',
  port,
  ...(process.env.ADVERTISE_HOST ? { advertiseHost: process.env.ADVERTISE_HOST } : {}),
  ...(process.env.SPEAKER_UUID ? { uuid: process.env.SPEAKER_UUID } : {}),
  ...(process.env.ROOM_NAME ? { roomName: process.env.ROOM_NAME } : {}),
})

const { seedHost } = await fake.start()
console.log(`fake-sonos listening on ${seedHost} (speaker ${fake.speakerId})`)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void fake.stop().then(() => process.exit(0))
  })
}
