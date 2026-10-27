# syntax=docker/dockerfile:1.7
# The authoritative boilerplate scripts invoke Node's native test runner.  Bun
# is the worker runtime, but is not a drop-in `node --test` implementation, so
# copy the real, digest-pinned Node runtime already used by the development
# worker rather than aliasing node to Bun.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS node-runtime

# Static BusyBox provides the small `ip` applet needed before capabilities are
# dropped.  Pin the multi-architecture OCI manifest, not a moving tag.
FROM busybox:1.36.1-musl@sha256:3c6ae8008e2c2eedd141725c30b20d9c36b026eb796688f88205845ef17aa213 AS net-tools

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
RUN bun -e 'const response = await fetch("https://registry.npmjs.org/pnpm/-/pnpm-10.8.0.tgz"); if (!response.ok) process.exit(1); await Bun.write("/tmp/pnpm-10.8.0.tgz", await response.arrayBuffer())' \
    && bun -e 'const expected = "sha512-DoJxTRtbQ8dGEBk8sgc0iXwdAN6J0OGEIK68WXf6E9eAqcsFc0Yk6B69gcyHbNRkeUhQZBxIuVRDJrViLKKZcQ=="; const actual = "sha512-" + Buffer.from(await crypto.subtle.digest("SHA-512", await Bun.file("/tmp/pnpm-10.8.0.tgz").arrayBuffer())).toString("base64"); if (actual !== expected) process.exit(1)' \
    && mkdir -p /toolchain/pnpm-10.8 /toolchain/pnpm-store \
    && tar -xzf /tmp/pnpm-10.8.0.tgz -C /toolchain/pnpm-10.8 --strip-components=1 \
    && cd /toolchain/boilerplate-template \
    && bun /toolchain/pnpm-10.8/bin/pnpm.cjs fetch --frozen-lockfile --store-dir /toolchain/pnpm-store \
    && bun /toolchain/pnpm-10.8/bin/pnpm.cjs install --offline --frozen-lockfile --ignore-scripts --store-dir /toolchain/pnpm-store

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
COPY --from=intake /toolchain/pnpm-10.8 /toolchain/pnpm-10.8
COPY --from=intake /toolchain/pnpm-store /toolchain/pnpm-store
COPY --from=node-runtime /usr/bin/node /usr/local/bin/node
COPY --from=net-tools /bin/busybox /toolchain/bin/busybox
RUN ln -s /usr/local/bin/bun /toolchain/bin/bun \
    && ln -s /toolchain/pnpm-10.8/bin/pnpm.cjs /toolchain/bin/pnpm \
    && ln -s /toolchain/node_modules/.bin/napplet-conformance /toolchain/bin/napplet-conformance \
    && PLAYWRIGHT_BROWSERS_PATH=/toolchain/ms-playwright node -e 'const {realpathSync}=require("node:fs");const {execFileSync}=require("node:child_process");const {dirname,join}=require("node:path");const pkg=require.resolve("playwright/package.json",{paths:[realpathSync("node_modules/@napplet/conformance-cli")]});execFileSync(process.execPath,[join(dirname(pkg),"cli.js"),"install","chromium"],{stdio:"inherit"})' \
    && cd /toolchain/boilerplate-template && PLAYWRIGHT_BROWSERS_PATH=/toolchain/ms-playwright node -e 'const {realpathSync}=require("node:fs");const {execFileSync}=require("node:child_process");const {dirname,join}=require("node:path");const pkg=require.resolve("playwright/package.json",{paths:[realpathSync("node_modules/@napplet/conformance-cli")]});execFileSync(process.execPath,[join(dirname(pkg),"cli.js"),"install","chromium"],{stdio:"inherit"})' \
    && chmod 0555 /toolchain/bin/busybox \
    && mkdir -p /home/napplet /work /tmp \
    && chown 65532:65532 /home/napplet /work /tmp \
    && chmod -R go-w /toolchain \
    && command -v mount \
    && node --version \
    && /toolchain/bin/busybox ip link show lo \
    && command -v findmnt \
    && command -v setpriv \
    && command -v mountpoint \
    && test -x /toolchain/bin/napplet \
    && test -d /toolchain/boilerplate-template \
    && test -d /toolchain/ms-playwright
# Browser archives alone do not contain the Linux shared libraries. Install
# the dependency set selected by the pinned Playwright CLI at image intake.
RUN node -e 'const {realpathSync}=require("node:fs");const {execFileSync}=require("node:child_process");const {dirname,join}=require("node:path");const pkg=require.resolve("playwright/package.json",{paths:[realpathSync("node_modules/@napplet/conformance-cli")]});execFileSync(process.execPath,[join(dirname(pkg),"cli.js"),"install-deps","chromium"],{stdio:"inherit"})'
# Keep trusted harness changes after the pinned dependency/browser layers.
COPY infra/toolchain/denial-probe.ts /toolchain/bin/denial-probe
COPY infra/toolchain/fixture-runner.ts /toolchain/bin/fixture-runner
COPY infra/toolchain/production-worker.ts /usr/local/bin/napplet-cvm-worker
COPY infra/toolchain/production-probe.ts /usr/local/bin/napplet-cvm-probe
COPY infra/toolchain/production-bootstrap.sh /usr/local/bin/napplet-cvm-bootstrap
RUN chmod 0555 /toolchain/bin/denial-probe /toolchain/bin/fixture-runner /usr/local/bin/napplet-cvm-worker /usr/local/bin/napplet-cvm-probe /usr/local/bin/napplet-cvm-bootstrap
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
