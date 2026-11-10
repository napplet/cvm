# napplet-cvm service image. Starts only `scripts/production.ts`, which reads
# /etc/napplet-cvm/service.json and /run/secrets/napplet-cvm/*.
FROM docker:29.9.2-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker
FROM denoland/deno:2.2.1@sha256:6d81d5e0e623703b1dafeb8f1df7d73a53299bb632edf1be908ac2f53ee46e0a AS nostrbook
WORKDIR /build
COPY infra/service/nostrbook-deno.lock ./deno.lock
# Nostrbook is a fixed, read-only documentation process.  The compiled binary
# has network permission only for its two upstream documentation origins.
RUN deno compile --node-modules-dir=none --lock=deno.lock --frozen --allow-net=nostrbook.dev,raw.githubusercontent.com --output /out/nostrbook jsr:@nostrbook/mcp@0.3.0
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
COPY --from=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=nostrbook /out/nostrbook /usr/local/bin/nostrbook
COPY infra/service/nostrbook-LICENSE /usr/local/share/licenses/nostrbook/LICENSE
RUN chmod 0555 /usr/local/bin/nostrbook
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile
COPY tests/dev-ui/package.json tests/dev-ui/bun.lock ./tests/dev-ui/
RUN cd tests/dev-ui && bun install --frozen-lockfile && bun node_modules/playwright/cli.js install chromium
COPY . .
ARG NAPPLET_CVM_REVISION=unknown
ENV DOCKER_HOST=unix:///run/cvm-docker/docker.sock TMPDIR=/scratch NAPPLET_CVM_REVISION=${NAPPLET_CVM_REVISION}
LABEL org.opencontainers.image.revision=${NAPPLET_CVM_REVISION}
EXPOSE 8080
ENTRYPOINT ["bun", "scripts/production.ts"]
