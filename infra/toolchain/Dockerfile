# syntax=docker/dockerfile:1.7
# The base image is an immutable multi-platform index for Bun 1.3.14.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS intake
ARG TARGETARCH

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
RUN case "$TARGETARCH" in \
      arm64) asset=aarch64; digest=35ffb0d21e75877e749d63569b4369e5b467967e48034c2ee7d0ae958ed5ee54 ;; \
      amd64) asset=x86_64; digest=a17fd2f61beb3b1553518b517045c4e1a474ddee5db87be80e18cf1bd24d8e28 ;; \
      *) exit 1 ;; \
    esac \
    && NAPPLET_CLI_ASSET="$asset" bun -e 'const response = await fetch(`https://github.com/napplet/web/releases/download/%40napplet/cli%400.5.2/napplet-linux-${process.env.NAPPLET_CLI_ASSET}`); if (!response.ok) process.exit(1); await Bun.write("/toolchain/napplet", await response.arrayBuffer())' \
    && echo "$digest  /toolchain/napplet" | sha256sum --check \
    && chmod 0555 /toolchain/napplet

# The registry boilerplate package intentionally omits its lockfile.  The
# worker must use the same integrity-pinned source substrate as the verified
# development flow so frozen offline installation remains meaningful.
ADD --checksum=sha256:7d66183c30454ec40ca2458d38dedde827fa1f8b58a2fbcd25a3b7d1c3bf538b https://codeload.github.com/napplet/boilerplate/tar.gz/cbbebe9bd56271277b054535c0a8d720a588f61d /tmp/boilerplate.tgz
RUN mkdir -p /toolchain/boilerplate-template \
    && tar -xzf /tmp/boilerplate.tgz -C /toolchain/boilerplate-template --strip-components=1

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
COPY --from=intake /toolchain/boilerplate-template /toolchain/boilerplate-template
COPY infra/toolchain/denial-probe.ts /toolchain/bin/denial-probe
COPY infra/toolchain/fixture-runner.ts /toolchain/bin/fixture-runner
COPY infra/toolchain/production-worker.ts /usr/local/bin/napplet-cvm-worker
COPY infra/toolchain/production-probe.ts /usr/local/bin/napplet-cvm-probe
COPY infra/toolchain/production-bootstrap.sh /usr/local/bin/napplet-cvm-bootstrap
RUN ln -s /usr/local/bin/bun /usr/local/bin/node \
    && ln -s /usr/local/bin/bun /toolchain/bin/bun \
    && ln -s /toolchain/node_modules/.bin/napplet-conformance /toolchain/bin/napplet-conformance \
    && PLAYWRIGHT_BROWSERS_PATH=/toolchain/ms-playwright node -e 'const {realpathSync}=require("node:fs");const {execFileSync}=require("node:child_process");const {dirname,join}=require("node:path");const pkg=require.resolve("playwright/package.json",{paths:[realpathSync("node_modules/@napplet/conformance-cli")]});execFileSync(process.execPath,[join(dirname(pkg),"cli.js"),"install","chromium"],{stdio:"inherit"})' \
    && chmod 0555 /toolchain/bin/denial-probe /toolchain/bin/fixture-runner /usr/local/bin/napplet-cvm-worker /usr/local/bin/napplet-cvm-probe /usr/local/bin/napplet-cvm-bootstrap \
    && mkdir -p /home/napplet /work /tmp \
    && chown 65532:65532 /home/napplet /work /tmp \
    && chmod -R go-w /toolchain /usr/local/bin/napplet-cvm-worker /usr/local/bin/napplet-cvm-probe /usr/local/bin/napplet-cvm-bootstrap \
    && command -v mount \
    && command -v findmnt \
    && command -v setpriv \
    && command -v mountpoint \
    && test -x /toolchain/bin/napplet \
    && test -d /toolchain/boilerplate-template \
    && test -d /toolchain/ms-playwright
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
