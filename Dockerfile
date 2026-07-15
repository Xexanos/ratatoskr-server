# Single multi-stage Dockerfile for the Ratatoskr server (SPEC section 12).
# Built for amd64 and arm64 (multi-arch) in CI; a plain `docker build .` produces the
# host-arch image. Build context is the REPO ROOT (the app is a pnpm workspace package).
#
#   docker build -t ratatoskr-server .
#
# Runtime configuration is via environment variables (see .env.example / SPEC section 7).
# Sonos discovery/eventing needs the host LAN, so run with host networking on Linux
# (`--network host`) or set SONOS_SEED_HOST (SPEC section 12, "Container networking").

# syntax=docker/dockerfile:1

# ---- Build stage: install workspace deps, generate the contract artifacts, compile TS ----
# Pinned to $BUILDPLATFORM so a multi-arch build compiles ONCE on the builder's native arch instead
# of re-running pnpm/tsc under QEMU emulation for each target (minutes-to-hangs slow in CI). Safe
# because the output shipped to runtime — the compiled JS in dist plus the `pnpm deploy --prod`
# node_modules — is architecture-independent: every runtime dependency (@svrooij/sonos,
# fast-xml-parser, fastify, fastify-openapi-glue, undici, and the built workspace packages) is pure
# JavaScript with no native/arch-specific binaries. Only the runtime stage below is per-arch.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pin pnpm to the version the repo declares (package.json "packageManager").
RUN corepack enable
WORKDIR /repo

# Manifests first, so `pnpm install` is cached until a package.json or the lockfile changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/app/package.json            packages/app/
COPY packages/contract/package.json       packages/contract/
COPY packages/position/package.json       packages/position/
COPY packages/fake-sonos/package.json     packages/fake-sonos/
COPY packages/integration-tests/package.json packages/integration-tests/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# Sources needed to generate the contract artifacts and build the three runtime packages.
# fake-sonos and integration-tests are test-only and never enter the runtime image.
COPY contract ./contract
COPY packages/contract packages/contract
COPY packages/position packages/position
COPY packages/app packages/app

# Generate types/schemas/openapi-document from contract/openapi.yaml, then compile.
RUN pnpm run generate \
 && pnpm --filter @ratatoskr/contract --filter @ratatoskr/position --filter @ratatoskr/app run build

# Emit a self-contained deployment of just @ratatoskr/app: its dist plus a flat, production-only
# node_modules (workspace deps @ratatoskr/contract and @ratatoskr/position injected as built code).
# Nothing dev-only and no workspace/source layout ships to runtime (SPEC section 12).
# --legacy: our workspace deps aren't "injected", which pnpm v10+ requires for the default
# deploy path; the legacy deploy resolves workspace:* links from the built packages instead.
RUN pnpm --filter @ratatoskr/app deploy --prod --legacy /prod

# Guard the $BUILDPLATFORM cross-compile above: it is only safe while every shipped runtime dep is
# architecture-independent. A native addon (*.node) in the production deploy means an amd64 binary
# would be baked into the arm64 image and crash only at runtime — so fail the build the moment such
# a dep is introduced, instead of shipping a broken image. If this fires: replace the dependency
# with a pure-JS one, or drop the `--platform=$BUILDPLATFORM` pin on the build stage above (which
# reverts to a correct but slow, per-arch QEMU-emulated build). The arm64 smoke job in
# container.yml is the behavioural backstop for anything this static check can't see.
RUN if find /prod -name '*.node' -type f | grep -q .; then \
      echo "ERROR: native binary (*.node) found in the production deploy — the multi-arch build cross-compiles on amd64, so this would ship a wrong-arch binary in the arm64 image. See the note above this RUN in the Dockerfile." >&2; \
      find /prod -name '*.node' -type f >&2; \
      exit 1; \
    fi

# ---- Runtime stage: slim, non-root, app + production deps only ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# The server binds 0.0.0.0:PORT (default 8080). Override PORT at runtime if needed.
ENV PORT=8080
# openssl: the entrypoint generates a self-signed certificate when no transport is configured
# (see docker-entrypoint.sh / SPEC section 14). /tls is its default output dir; pre-create it
# owned by the runtime user so a fresh named volume inherits writable ownership.
RUN apk add --no-cache openssl && mkdir -p /tls && chown node:node /tls
WORKDIR /app
COPY --from=build --chown=node:node /prod ./
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Run unprivileged (SPEC section 14: the container runs as a non-root user). `node` is a
# built-in uid 1000 in the official images.
USER node
EXPOSE 8080

# Liveness: is the listener accepting connections? A raw TCP connect works regardless of
# whether the server is serving HTTP or HTTPS (TLS_CERT_PATH/TLS_KEY_PATH). It does not
# assert ABS/Sonos reachability — /v1/health reports that, but a degraded neighbor must not
# mark the container itself unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD \
  node -e "require('net').connect(Number(process.env.PORT||8080),'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

# The entrypoint selects the transport (own cert / plain HTTP / auto self-signed) then execs the
# CMD. One process, one container. SIGTERM triggers the graceful-shutdown drain (SPEC section 5).
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
