import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { planPlayback, planSeek, type PlaybackPlan, type SeekTuning } from '@ratatoskr/position'
import { SonosClient } from '../src/sonos/client.js'
import { SonosUpstreamError } from '../src/sonos/errors.js'
import { FakeSonos } from '../test-support/fakeSonos.js'

// Sonos-control component test: the real SonosClient driving the real UPnP/SOAP double over HTTP
// (SPEC §4 / docs/testing.md). SONOS_DISABLE_EVENTS makes @svrooij/sonos skip UPnP eventing so the
// double only needs the control SOAP.

const TUNING: SeekTuning = { settleMs: 0, toleranceSeconds: 3, retries: 2 }
const SPEAKER = 'RINCON_FAKE01'

function twoTrackPlan(): PlaybackPlan {
  return planPlayback([
    { url: 'http://abs/api/items/li_1/file/10?token=s', mimeType: 'audio/mpeg', durationSeconds: 100, title: 'One' },
    { url: 'http://abs/api/items/li_1/file/20?token=s', mimeType: 'audio/mp4', durationSeconds: 200, title: 'Two' },
  ])
}

describe('SonosClient playback against the fake Sonos', () => {
  let fake: FakeSonos
  let client: SonosClient
  let port = 0

  beforeAll(async () => {
    process.env.SONOS_DISABLE_EVENTS = '1'
    fake = new FakeSonos({ uuid: SPEAKER, roomName: 'Test Room' })
    const info = await fake.start()
    port = info.port
    client = new SonosClient(info.seedHost)
  })

  afterAll(async () => {
    await client.close()
    await fake.stop()
    delete process.env.SONOS_DISABLE_EVENTS
  })

  it('lists the speaker from the fake topology', async () => {
    expect(await client.listSpeakers()).toEqual([{ id: SPEAKER, name: 'Test Room', isGroup: false }])
  })

  it('enqueues each track with DIDL carrying the mime, points at the queue, and plays', async () => {
    await client.startPlayback(SPEAKER, twoTrackPlan())

    expect(fake.queue.map((track) => track.uri)).toEqual([
      'http://abs/api/items/li_1/file/10?token=s',
      'http://abs/api/items/li_1/file/20?token=s',
    ])
    // DIDL-Lite must carry the mime per track (a bare URL would 714 — SPEC §4).
    expect(fake.queue[0]?.metadata).toContain('protocolInfo="http-get:*:audio/mpeg:*"')
    expect(fake.queue[1]?.metadata).toContain('protocolInfo="http-get:*:audio/mp4:*"')
    expect(fake.transportUri).toBe(`x-rincon-queue:${SPEAKER}#0`)
    expect(fake.transportState).toBe('PLAYING')
  })

  it('seeks to the target track and in-track offset, trusting RelTime', async () => {
    // 250s into a [100, 200] book -> track index 1 (2nd track), 150s in.
    await client.seek(SPEAKER, planSeek([100, 200], 250, TUNING))
    expect(fake.currentTrack).toBe(2) // 1-based on the wire
    expect(fake.relTimeSeconds).toBe(150)
    expect(await client.getPosition(SPEAKER)).toEqual({ trackIndex: 1, relTimeSeconds: 150 })
  })

  it('reads transport state and stops', async () => {
    expect(await client.getTransportState(SPEAKER)).toBe('PLAYING')
    await client.stop(SPEAKER)
    expect(fake.transportState).toBe('STOPPED')
    expect(await client.getTransportState(SPEAKER)).toBe('STOPPED')
  })

  it('maps an unknown speaker id to a Sonos upstream error', async () => {
    await expect(client.startPlayback('RINCON_UNKNOWN', twoTrackPlan())).rejects.toBeInstanceOf(SonosUpstreamError)
  })

  it('the double rejects an enqueue without DIDL metadata (documents the 714 quirk)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/MediaRenderer/AVTransport/Control`, {
      method: 'POST',
      headers: {
        SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#AddURIToQueue"',
        'content-type': 'text/xml; charset=utf8',
      },
      body:
        '<s:Envelope><s:Body><u:AddURIToQueue>' +
        '<EnqueuedURI>http://abs/api/items/li_1/file/99?token=s</EnqueuedURI>' +
        '<EnqueuedURIMetaData></EnqueuedURIMetaData>' +
        '</u:AddURIToQueue></s:Body></s:Envelope>',
    })
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('714')
  })
})

describe('SonosClient against a vanished speaker', () => {
  it('wraps a transport failure as SonosUpstreamError', async () => {
    process.env.SONOS_DISABLE_EVENTS = '1'
    const fake = new FakeSonos({ uuid: SPEAKER })
    const info = await fake.start()
    const client = new SonosClient(info.seedHost)
    await client.listSpeakers() // initialize the manager against the running fake
    await fake.stop() // the speaker is now unreachable
    await expect(client.getTransportState(SPEAKER)).rejects.toBeInstanceOf(SonosUpstreamError)
    await client.close()
    delete process.env.SONOS_DISABLE_EVENTS
  })
})
