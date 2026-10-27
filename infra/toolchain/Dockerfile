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
RUN bun -e 'const response = await fetch("https://github.com/napplet/web/releases/download/%40napplet/cli%400.5.2/napplet-linux-x86_64"); if (!response.ok) process.exit(1); await Bun.write("/toolchain/napplet", await response.arrayBuffer())' \
    && echo '46685f2e4df516b5b2e7e2e133480c90e5c85dbd36d05c6e95f4eee6af33ec5e  /toolchain/napplet' | sha256sum --check \
    && chmod 0555 /toolchain/napplet

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS sealed

ENV HOME=/home/napplet \
    CI=1 \
    PNPM_HOME=/toolchain/pnpm \
    PLAYWRIGHT_BROWSERS_PATH=/toolchain/ms-playwright \
    PATH=/toolchain/bin:/toolchain/node_modules/.bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /toolchain
COPY --from=intake /root/.bun /root/.bun
COPY --from=intake /root/.bun/install/global/node_modules/pnpm /toolchain/pnpm
COPY --from=intake /root/.local/share/pnpm/store /root/.local/share/pnpm/store
COPY --from=intake /toolchain/package.json /toolchain/pnpm-lock.yaml /toolchain/
COPY --from=intake /toolchain/node_modules /toolchain/node_modules
COPY --from=intake /toolchain/napplet /toolchain/bin/napplet
COPY infra/toolchain/denial-probe.ts /toolchain/bin/denial-probe
COPY infra/toolchain/fixture-runner.ts /toolchain/bin/fixture-runner
COPY infra/toolchain/production-worker.ts /usr/local/bin/napplet-cvm-worker
COPY infra/toolchain/production-probe.ts /usr/local/bin/napplet-cvm-probe
COPY infra/toolchain/production-bootstrap.sh /usr/local/bin/napplet-cvm-bootstrap
RUN ln -s /usr/local/bin/bun /usr/local/bin/node \
    && ln -s /usr/local/bin/bun /toolchain/bin/bun \
    && ln -s /toolchain/node_modules/.bin/napplet-conformance /toolchain/bin/napplet-conformance \
    && mkdir -p /toolchain/boilerplate-template \
    && cp -a /toolchain/node_modules/@napplet/boilerplate/. /toolchain/boilerplate-template/ \
    && chmod 0555 /toolchain/bin/denial-probe /toolchain/bin/fixture-runner /usr/local/bin/napplet-cvm-worker /usr/local/bin/napplet-cvm-probe /usr/local/bin/napplet-cvm-bootstrap \
    && mkdir -p /home/napplet /work /tmp \
    && chown 65532:65532 /home/napplet /work /tmp \
    && chmod -R go-w /toolchain /usr/local/bin/napplet-cvm-worker /usr/local/bin/napplet-cvm-probe /usr/local/bin/napplet-cvm-bootstrap \
    && command -v mount \
    && command -v findmnt \
    && command -v setpriv \
    && test -x /toolchain/bin/napplet \
    && test -d /toolchain/boilerplate-template
USER 65532:65532
ENTRYPOINT ["/toolchain/bin/bun"]

# This target is selected only by an approved production-worker image build.
# The normal sealed-toolchain target above remains non-root.  The bootstrap
# immediately rejects anything except the provider-provisioned bounded tmpfs
# and then drops to UID 65532 before any worker command is executed.
FROM sealed AS production-worker
USER root
ENTRYPOINT ["/usr/local/bin/napplet-cvm-bootstrap"]

# Keep an unprivileged target last so an unqualified Docker build preserves the
# historical sealed-toolchain behaviour rather than selecting the root stage.
FROM sealed AS default
USER 65532:65532
ENTRYPOINT ["/toolchain/bin/bun"]
