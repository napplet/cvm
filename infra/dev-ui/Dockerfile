# Development-only worker image. This is not a promoted production toolchain.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
COPY --from=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 /usr/local/bin/bun /usr/local/bin/bun
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) asset=aarch64; digest=35ffb0d21e75877e749d63569b4369e5b467967e48034c2ee7d0ae958ed5ee54 ;; \
      amd64) asset=x86_64; digest=a17fd2f61beb3b1553518b517045c4e1a474ddee5db87be80e18cf1bd24d8e28 ;; \
      *) exit 1 ;; \
    esac && curl -fsSL "https://github.com/napplet/web/releases/download/%40napplet/cli%400.5.2/napplet-linux-$asset" -o /usr/local/bin/napplet && echo "$digest  /usr/local/bin/napplet" | sha256sum -c -
ADD --checksum=sha256:7d66183c30454ec40ca2458d38dedde827fa1f8b58a2fbcd25a3b7d1c3bf538b https://codeload.github.com/napplet/boilerplate/tar.gz/cbbebe9bd56271277b054535c0a8d720a588f61d /tmp/boilerplate.tgz
RUN chmod 0555 /usr/local/bin/napplet && mkdir -p /opt/template /work /output /home/napplet && tar -xzf /tmp/boilerplate.tgz -C /opt/template --strip-components=1 && chmod -R a+rX /opt/template && chmod 0777 /work /output /home/napplet
RUN corepack enable && corepack prepare pnpm@10.8.0 --activate
RUN cp -a /root/.cache/node/corepack/v1/pnpm/10.8.0 /opt/pnpm && cd /opt/template && node /opt/pnpm/bin/pnpm.cjs install --frozen-lockfile --ignore-scripts --store-dir /opt/pnpm-store && chmod -R a+rx /opt/pnpm /opt/pnpm-store
RUN cd /opt/template && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright node -e 'const {realpathSync}=require("node:fs");const {execFileSync}=require("node:child_process");const {dirname,join}=require("node:path");const pkg=require.resolve("playwright/package.json",{paths:[realpathSync("node_modules/@napplet/conformance-cli")]});execFileSync(process.execPath,[join(dirname(pkg),"cli.js"),"install","chromium"],{stdio:"inherit"})' && chmod -R a+rx /opt/ms-playwright
COPY authoring-skills /opt/authoring-skills
COPY authoring-skills.ts /opt/authoring-skills.ts
COPY source-capabilities.ts /opt/source-capabilities.ts
COPY run-proposal.ts /usr/local/bin/run-proposal
RUN chmod 0555 /usr/local/bin/run-proposal
ENV HOME=/home/napplet CI=1 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["bun", "/usr/local/bin/run-proposal"]
