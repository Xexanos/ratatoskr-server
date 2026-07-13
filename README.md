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

- An Audiobookshelf server, version 2.26 or newer.
- Sonos or IKEA SYMFONISK speakers on the same local network. Ratatoskr controls them
  directly over UPnP; no separate Sonos controller process is needed.

### Set up the streamer account in Audiobookshelf

Individual listeners log in with their own Audiobookshelf accounts, so their progress is
saved to the right person. Separately, Ratatoskr needs one **dedicated, low-privilege
account** whose **API key** it puts into the audio URLs handed to the speakers (any device
on the LAN can read those URLs, so this account is deliberately not a real user's, and the
key is scoped to read/stream only):

1. In Audiobookshelf, go to **Settings → Users → Add User**.
2. Create a **Guest** account, e.g. `ratatoskr-streamer` (any password is fine — Ratatoskr won't
   use it). Guest has the same read/stream access as a normal user but is even more limited (it
   can't change its own password); a plain **User** works too. Do not use **Admin**.
3. Restrict it to the audiobook library you want to play, and turn **off** the *download*
   permission — it only needs to stream; it needs no upload/delete either.
4. Create an **API key** for that account under **Settings → Users → API Keys** (make sure it
   is **active**), and put the key into `ABS_STREAMER_API_KEY` (below).

The key is long-lived: an API key can't be exchanged for a short-lived token, and the URL
must keep working across a multi-hour book. A leaked media URL is therefore bounded by
*scope* — read/stream of the library only, never a real account — rather than by expiry.

## Configuration

Configuration is via environment variables. Copy the example file and fill it in:

```sh
cp .env.example .env
```

The `dev` and `start` scripts load `.env` automatically (Node's `--env-file`). The full
list of variables, with defaults, lives in [`.env.example`](.env.example). The required
ones are `ABS_URL` and `ABS_STREAMER_API_KEY`; the server also
requires TLS (`TLS_CERT_PATH` / `TLS_KEY_PATH`) unless you set `ALLOW_PLAIN_HTTP=true`,
so credentials aren't sent in cleartext. On startup, any missing or invalid variable is
reported — all problems at once — and the server refuses to run.

## Running with Docker

The server ships as a single multi-arch container image (see [`docs/deploy.md`](docs/deploy.md)).
Build it from the repo root and run it with host networking so it can reach the Sonos speakers:

```sh
docker build -t ratatoskr-server .
docker run --rm --network host \
  -e ABS_URL=https://abs.lan:13378 \
  -e ABS_STREAMER_API_KEY=... \
  -e ALLOW_PLAIN_HTTP=true \
  ratatoskr-server
```

Configuration is the same set of environment variables as above. Where host networking is not
available, set `SONOS_SEED_HOST` (SPEC section 12). Published images live at
`ghcr.io/xexanos/ratatoskr-server`.

## Development

This is a pnpm workspace of three packages: `position` (pure position-mapping logic),
`contract` (types and schemas generated from `contract/openapi.yaml`), and `app` (the
Fastify service).

```sh
pnpm install
pnpm run build          # regenerates the contract package, then builds all packages
pnpm run test           # unit tests (90% coverage thresholds enforced)
pnpm --filter @ratatoskr/app run test:integration   # spawns the built server, needs a prior build
pnpm run dev            # runs the app with live reload
```

The `contract` package regenerates the request/response types **and** the runtime JSON
schemas from `contract/openapi.yaml` in its build step, so the code can never reference a
shape the contract doesn't define. Note that Fastify's response schemas only *serialize*
(they enforce required fields and drop unknown ones); they do not validate enum values or
shapes. Real response conformance is asserted separately — the integration tests validate
against the contract with Ajv, and response validation is enabled in test builds.

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
