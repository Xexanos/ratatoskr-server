# Ratatoskr

A companion service that bridges [Audiobookshelf](https://www.audiobookshelf.org/)
and [Sonos](https://www.sonos.com/) speakers, and keeps your listening progress
in sync.

Play an audiobook from your phone onto your Sonos speakers, and have the position
you reach written straight back into Audiobookshelf, so the next time you open the
app on any device you pick up exactly where you left off.

## About the name

In Norse mythology, Ratatoskr is the squirrel that scurries up and down the world
tree Yggdrasil, carrying messages between the eagle perched at the crown and the
serpent Nidhoggr coiled at the roots. Two parties that cannot talk to each other
directly, and a small, quick messenger running between them.

That is exactly what this service does. Audiobookshelf and your Sonos speakers do
not speak the same language, so Ratatoskr runs between them: it carries the
playback commands one way and the listening progress the other.

## Why it exists

Audiobookshelf is excellent, but it has no good way to drive Sonos speakers. AirPlay
covers this for iPhone users, but there is no native AirPlay sender on Android, and
Sonos does not support Google Cast either. Ratatoskr solves this by controlling the
speakers from the server side, which makes it fully platform independent and, unlike
AirPlay, keeps the phone from having to be the audio source.

## How it works

Ratatoskr is the brain; the client app is a thin remote. The important detail is that
the audio never passes through Ratatoskr:

- The client asks Ratatoskr to play a book on a speaker.
- Ratatoskr tells the Sonos speaker to stream the audio file directly from
  Audiobookshelf over the local network.
- Ratatoskr polls the speaker's position, maps it back onto the audiobook's timeline,
  and writes the progress to Audiobookshelf.

Audiobookshelf remains the single source of truth for progress. Ratatoskr keeps only
the currently playing session in memory.

## Status

Early work in progress. The first milestone (v1) targets a single audiobook playing
on a single speaker or group, with play, pause, seek, resume, and reliable progress
sync. Multiroom grouping, chapter awareness, and podcasts are planned for later.

## Requirements

- An Audiobookshelf server, version 2.26 or newer, and a permanent API key
  (see the Audiobookshelf API key guide).
- [node-sonos-http-api](https://github.com/jishi/node-sonos-http-api) reachable on the
  same local network as your speakers.
- Sonos or IKEA SYMFONISK speakers on that same network.

## Configuration

Configuration is provided through environment variables:

- `ABS_URL` — LAN URL of the Audiobookshelf server (for example `http://192.168.1.50:13378`).
- `ABS_TOKEN` — Audiobookshelf API key.
- `SONOS_HTTP_API_URL` — URL of the node-sonos-http-api instance.
- `RATATOSKR_TOKEN` — optional shared token clients must present. If unset, auth is disabled.
- `POLL_INTERVAL_SECONDS` — how often to poll the speaker (default 15).

## API

The HTTP API between the server and its clients is described in
[`contract/openapi.yaml`](contract/openapi.yaml), which is the single source of truth
for that communication. Client code is generated from it.

## The Android app

The client app lives in a separate repository:
[ratatoskr-app](https://github.com/Xexanos/ratatoskr-app).

## Contributing

See [`docs/SPEC.md`](docs/SPEC.md) for the design and the scope of the first version.

## License

Ratatoskr is licensed under the GNU General Public License, version 3 or later
(GPL-3.0-or-later). See [`LICENSE`](LICENSE).

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by, or associated
with Sonos Inc. or the Audiobookshelf project. "Sonos" and "Audiobookshelf" are used
only to describe compatibility.
