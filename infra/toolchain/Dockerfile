# syntax=docker/dockerfile:1.7
# The base image is an immutable multi-platform index for Bun 1.3.14.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS intake

WORKDIR /toolchain
COPY toolchains/locks/initial/package.json package.json
COPY toolchains/locks/initial/pnpm-lock.yaml pnpm-lock.yaml

# This is the sole networked boundary: exact package tarballs are fetched before
# the final stage. Corepack is not present in the pinned Bun image, so pnpm is
# installed from one integrity-checked tarball rather than a floating resolver.
RUN bun -e 'const response = await fetch("https://registry.npmjs.org/pnpm/-/pnpm-10.24.0.tgz"); if (!response.ok) process.exit(1); await Bun.write("/tmp/pnpm.tgz", await response.arrayBuffer())' \
    && bun -e 'const expected = "sha512-Af+K5xtEGZA7ZcYPstydNM+LtuBtA73hEu8496NNaQTEJLpmvqXNzxKJAjC/OflYBHMUDtnJRv7zKLblI4o0Wg=="; const actual = "sha512-" + Buffer.from(await crypto.subtle.digest("SHA-512", await Bun.file("/tmp/pnpm.tgz").arrayBuffer())).toString("base64"); if (actual !== expected) process.exit(1)' \
    && bun install --global --ignore-scripts /tmp/pnpm.tgz \
    && pnpm --version | grep -Fx '10.24.0' \
    && pnpm fetch --frozen-lockfile --ignore-scripts \
    && pnpm install --frozen-lockfile --ignore-scripts

# The reviewed standalone CLI is independently verified rather than resolved by npm.
RUN bun -e 'const response = await fetch("https://github.com/napplet/web/releases/download/%40napplet/cli%400.5.1/napplet-linux-x86_64"); if (!response.ok) process.exit(1); await Bun.write("/toolchain/napplet", await response.arrayBuffer())' \
    && echo 'c533b129f6208348f50c99889bb29e13355ba68cab9092881b6478d5d88fd275  /toolchain/napplet' | sha256sum --check \
    && chmod 0555 /toolchain/napplet

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS sealed

ENV HOME=/home/napplet \
    CI=1 \
    PNPM_HOME=/toolchain/pnpm \
    PLAYWRIGHT_BROWSERS_PATH=/toolchain/ms-playwright \
    PATH=/toolchain/bin:/toolchain/node_modules/.bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /toolchain
COPY --from=intake /root/.bun /root/.bun
COPY --from=intake --chown=65532:65532 /root/.bun/install/global/node_modules/pnpm /toolchain/pnpm
COPY --from=intake --chown=65532:65532 /root/.local/share/pnpm/store /root/.local/share/pnpm/store
COPY --from=intake --chown=65532:65532 /toolchain/package.json /toolchain/pnpm-lock.yaml /toolchain/
COPY --from=intake --chown=65532:65532 /toolchain/node_modules /toolchain/node_modules
COPY --from=intake --chown=65532:65532 /toolchain/napplet /toolchain/bin/napplet
COPY --chown=65532:65532 infra/toolchain/denial-probe.ts /toolchain/bin/denial-probe
RUN ln -s /usr/local/bin/bun /usr/local/bin/node \
    && ln -s /usr/local/bin/bun /toolchain/bin/bun \
    && ln -s /toolchain/node_modules/.bin/napplet-conformance /toolchain/bin/napplet-conformance \
    && chmod 0555 /toolchain/bin/denial-probe \
    && mkdir -p /home/napplet /work /tmp \
    && chmod -R go-w /toolchain
USER 65532:65532
ENTRYPOINT ["/toolchain/bin/bun"]
