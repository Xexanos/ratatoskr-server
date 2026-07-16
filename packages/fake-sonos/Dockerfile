# Container image of the fake Sonos double for the central E2E stack (docs/testing.md).
# The package tsconfig extends the repo-root tsconfig.base.json, so build from the REPO ROOT:
#   docker build -f packages/fake-sonos/Dockerfile .
# The compile stage is pinned to $BUILDPLATFORM: the output is plain JavaScript (tsc, no native
# modules), so for a multi-arch build it compiles once on the builder's native arch instead of
# re-running npm+tsc under QEMU for each target. Only the tiny runtime stage differs per arch.
FROM --platform=$BUILDPLATFORM node:22.23.1-alpine AS build
WORKDIR /repo
COPY tsconfig.base.json ./
WORKDIR /repo/packages/fake-sonos
COPY packages/fake-sonos/package.json packages/fake-sonos/tsconfig.json ./
COPY packages/fake-sonos/src ./src
# The double has zero runtime dependencies (node:http only) — only the compiler is needed.
RUN npm install --no-package-lock --no-save typescript@6 @types/node@26 \
  && npx tsc -p tsconfig.json

FROM node:22.23.1-alpine
ENV NODE_ENV=production
USER node
WORKDIR /app
COPY --from=build /repo/packages/fake-sonos/dist ./dist
EXPOSE 1400
CMD ["node", "dist/main.js"]
