FROM docker:29.9.2-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
COPY --from=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tests/dev-ui/package.json tests/dev-ui/bun.lock ./tests/dev-ui/
RUN cd tests/dev-ui && bun install --frozen-lockfile && bun node_modules/playwright/cli.js install chromium
COPY . .
ENV DOCKER_HOST=unix:///run/cvm-docker/docker.sock NAPPLET_CVM_WORKER_PLATFORM=linux/amd64 TMPDIR=/scratch
EXPOSE 8080
ENTRYPOINT ["bun", "scripts/homelab.ts"]
