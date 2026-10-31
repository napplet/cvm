# Prepared direct-artifact profile; not the selected production default.
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
COPY toolchains/locks/capabilities-worker/package.json package.json
COPY toolchains/locks/capabilities-worker/pnpm-lock.yaml pnpm-lock.yaml

# This is the sole networked boundary: exact package tarballs are fetched before
# the final stage. Corepack is not present in the pinned Bun image, so pnpm is
# installed from one integrity-checked tarball rather than a floating resolver.
RUN bun -e 'const response = await fetch("https://registry.npmjs.org/pnpm/-/pnpm-10.24.0.tgz"); if (!response.ok) process.exit(1); await Bun.write("/tmp/pnpm.tgz", await response.arrayBuffer())' \
    && bun -e 'const expected = "sha512-Af+K5xtEGZA7ZcYPstydNM+LtuBtA73hEu8496NNaQTEJLpmvqXNzxKJAjC/OflYBHMUDtnJRv7zKLblI4o0Wg=="; const actual = "sha512-" + Buffer.from(await crypto.subtle.digest("SHA-512", await Bun.file("/tmp/pnpm.tgz").arrayBuffer())).toString("base64"); if (actual !== expected) process.exit(1)' \
    && bun install --global --ignore-scripts /tmp/pnpm.tgz \
    && pnpm --version | grep -Fx '10.24.0' \
    && pnpm fetch --frozen-lockfile --ignore-scripts \
    && pnpm install --frozen-lockfile --ignore-scripts

# The registry boilerplate package intentionally omits its lockfile.  The
# worker must use the same integrity-pinned source substrate as the verified
# development flow so frozen offline installation remains meaningful.
ADD --checksum=sha256:7d66183c30454ec40ca2458d38dedde827fa1f8b58a2fbcd25a3b7d1c3bf538b https://codeload.github.com/napplet/boilerplate/tar.gz/cbbebe9bd56271277b054535c0a8d720a588f61d /tmp/boilerplate.tgz
RUN mkdir -p /toolchain/boilerplate-template \
    && tar -xzf /tmp/boilerplate.tgz -C /toolchain/boilerplate-template --strip-components=1
COPY toolchains/overlays/capabilities-template/package.json toolchains/overlays/capabilities-template/pnpm-lock.yaml toolchains/overlays/capabilities-template/vite.config.ts /toolchain/boilerplate-template/
RUN bun -e 'const response = await fetch("https://registry.npmjs.org/pnpm/-/pnpm-10.8.0.tgz"); if (!response.ok) process.exit(1); await Bun.write("/tmp/pnpm-10.8.0.tgz", await response.arrayBuffer())' \
    && bun -e 'const expected = "sha512-DoJxTRtbQ8dGEBk8sgc0iXwdAN6J0OGEIK68WXf6E9eAqcsFc0Yk6B69gcyHbNRkeUhQZBxIuVRDJrViLKKZcQ=="; const actual = "sha512-" + Buffer.from(await crypto.subtle.digest("SHA-512", await Bun.file("/tmp/pnpm-10.8.0.tgz").arrayBuffer())).toString("base64"); if (actual !== expected) process.exit(1)' \
    && mkdir -p /toolchain/pnpm-10.8 /toolchain/pnpm-store \
    && tar -xzf /tmp/pnpm-10.8.0.tgz -C /toolchain/pnpm-10.8 --strip-components=1 \
    && cd /toolchain/boilerplate-template \
    && bun /toolchain/pnpm-10.8/bin/pnpm.cjs fetch --frozen-lockfile --store-dir /toolchain/pnpm-store \
    && bun /toolchain/pnpm-10.8/bin/pnpm.cjs install --offline --frozen-lockfile --ignore-scripts --store-dir /toolchain/pnpm-store

# The recreated upstream CLI asset cannot be bound to its historical tag.
# Build a distinct, source-bound executable instead: extract the immutable
# upstream workflow revision, verify the root lock, seed all Deno runtime and
# dependency cache entries, normalize Deno's serialized VFS mtimes, then make
# the final compile offline.  The final target hash is checked before it ever
# crosses into the sealed stage.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS cli-source
ARG TARGETARCH
COPY toolchains/locks/capabilities-cli/deno.lock /tmp/capabilities-cli.deno.lock
COPY --from=net-tools /bin/busybox /tmp/busybox
ADD --checksum=sha256:7f87d7fbd402c641cb0288c3730d615aad4ee1f2c32b17fc585b70956d455698 https://codeload.github.com/napplet/web/tar.gz/3c6e3ae33fea425b2f151740c0bd8c02f509ef7b /tmp/napplet-web.tgz
RUN case "$TARGETARCH" in \
      amd64) deno_asset=x86_64; target=x86_64-unknown-linux-gnu; deno_digest=394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2; cli_digest=5fbc61d2a4be189094726c7b7d7f073a00c122d93cedfa3bd37b7571fb430d08 ;; \
      arm64) deno_asset=aarch64; target=aarch64-unknown-linux-gnu; deno_digest=9a46afc6c392c7cd2ff71a31558935545b46408d0e87f7a86908c712721c046e; cli_digest=2a78a97ae95f493a0c568366ede5a53ce99808fa2fe487572952b7f4f9770a26 ;; \
      *) exit 1 ;; \
    esac \
    && mkdir -p /src /cache /runtime /out \
    && tar -xzf /tmp/napplet-web.tgz -C /src --strip-components=1 \
    && echo '7b08677e37bbfedfde17343a3612d223a547b8bf058df7e6c9c73881f9e7c0eb  /src/deno.lock' | sha256sum --check \
    && test "$(bun -e 'console.log(JSON.parse(await Bun.file("/src/packages/cli/deno.json").text()).version)')" = '0.13.0' \
    && cp /tmp/capabilities-cli.deno.lock /src/deno.lock \
    && echo '363cebbc9a8ca0cf5ef7cc7c81ccf2f598bb49ef0dfb6ae696b4a529cdc6f06d  /src/deno.lock' | sha256sum --check \
    && NAPPLET_DENO_ASSET="$deno_asset" bun -e 'const response = await fetch(`https://github.com/denoland/deno/releases/download/v2.9.6/deno-${process.env.NAPPLET_DENO_ASSET}-unknown-linux-gnu.zip`, { signal: AbortSignal.timeout(120_000) }); if (!response.ok) process.exit(1); await Bun.write("/tmp/deno.zip", await response.arrayBuffer())' \
    && echo "$deno_digest  /tmp/deno.zip" | sha256sum --check \
    && /tmp/busybox unzip -q /tmp/deno.zip -d /runtime \
    && /runtime/deno --version | grep -F 'deno 2.9.6 ' \
    && cd /src/packages/cli \
    && ulimit -t 900 \
    && DENO_DIR=/cache TZ=UTC LC_ALL=C LANG=C HOME=/home/deno SOURCE_DATE_EPOCH=1793178237 /tmp/busybox timeout 900 /runtime/deno cache --frozen --node-modules-dir=none src/standalone.ts \
    && DENO_DIR=/cache TZ=UTC LC_ALL=C LANG=C HOME=/home/deno SOURCE_DATE_EPOCH=1793178237 /tmp/busybox timeout 900 /runtime/deno compile --frozen --no-check --node-modules-dir=none --allow-read --allow-write --allow-run --allow-env --allow-net --target "$target" --output /out/seed src/standalone.ts \
    && find /src /cache -exec touch -h -d @1793178237 {} + \
    && DENO_DIR=/cache TZ=UTC LC_ALL=C LANG=C HOME=/home/deno SOURCE_DATE_EPOCH=1793178237 /tmp/busybox timeout 900 /runtime/deno compile --frozen --cached-only --no-check --node-modules-dir=none --allow-read --allow-write --allow-run --allow-env --allow-net --target "$target" --output /out/napplet src/standalone.ts \
    && echo "$cli_digest  /out/napplet" | sha256sum --check \
    && chmod 0555 /out/napplet

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS sealed

ENV HOME=/home/napplet \
    CI=1 \
    PNPM_HOME=/toolchain/pnpm \
    PLAYWRIGHT_BROWSERS_PATH=/toolchain/ms-playwright \
    PATH=/toolchain/bin:/toolchain/node_modules/.bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /toolchain
ARG CVM_WORKER_CONTRACT=nip5d-direct-v1
RUN case "$CVM_WORKER_CONTRACT" in nip5d-direct-v1|edge-native-v3-unpromoted) ;; *) exit 1 ;; esac \
    && printf '%s\n' "$CVM_WORKER_CONTRACT" > /toolchain/production-artifact-contract && chmod 0444 /toolchain/production-artifact-contract
COPY --from=intake /root/.bun /root/.bun
COPY --from=intake /root/.bun/install/global/node_modules/pnpm /toolchain/pnpm
COPY --from=intake /root/.local/share/pnpm/store /root/.local/share/pnpm/store
COPY --from=intake /toolchain/package.json /toolchain/pnpm-lock.yaml /toolchain/
COPY --from=intake /toolchain/node_modules /toolchain/node_modules
COPY --from=cli-source /out/napplet /toolchain/bin/napplet
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
COPY infra/toolchain/production-job.ts /usr/local/bin/napplet-cvm-job
COPY infra/toolchain/production-probe.ts /usr/local/bin/napplet-cvm-probe
COPY infra/toolchain/production-bootstrap.sh /usr/local/bin/napplet-cvm-bootstrap
COPY toolchains/recipes/capabilities-worker-current.json /toolchain/edge-worker-current.json
COPY toolchains/recipes/capabilities-worker-profile-v3-unpromoted.json /toolchain/edge-worker-profile-v3.json
RUN chmod 0555 /toolchain/bin/denial-probe /toolchain/bin/fixture-runner /usr/local/bin/napplet-cvm-worker /usr/local/bin/napplet-cvm-probe /usr/local/bin/napplet-cvm-bootstrap /usr/local/bin/napplet-cvm-job
USER 65532:65532
ENTRYPOINT ["/toolchain/bin/bun"]

# This target is selected only by an approved production-worker image build.
# The normal sealed-toolchain target above remains non-root.  The bootstrap
# immediately rejects anything except the provider-provisioned bounded tmpfs
# and then drops to UID 65532 before any worker command is executed.
FROM sealed AS production-worker
USER root
ENTRYPOINT ["/usr/local/bin/napplet-cvm-bootstrap"]

# The v3 edge ABI is a separate, explicitly unpromoted target. The direct v2
# target above never accepts a v3 request, even though both retain pinned
# authoring tooling and source substrate.
FROM sealed AS edge-production-worker
USER root
ENTRYPOINT ["/usr/local/bin/napplet-cvm-bootstrap"]

# Keep an unprivileged target last so an unqualified Docker build preserves the
# historical sealed-toolchain behaviour rather than selecting the root stage.
FROM sealed AS default
USER 65532:65532
ENTRYPOINT ["/toolchain/bin/bun"]
