# Publication tooling is independent of the already sealed generation toolchain.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
COPY --from=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 /usr/local/bin/bun /usr/local/bin/bun
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) asset=aarch64; digest=2459bab845ca735eea19dd5387133696b8f03143cbd08161a7fcddc2c32d3d8b ;; \
      amd64) asset=x86_64; digest=64678b48a227d9e1e0054db8d5a13d7aac114b8716fa097c5302ff6bc42f2ff7 ;; \
      *) exit 1 ;; \
    esac && curl -fsSL "https://github.com/napplet/web/releases/download/%40napplet/cli%400.10.0/napplet-linux-$asset" -o /usr/local/bin/napplet && echo "$digest  /usr/local/bin/napplet" | sha256sum -c -
ENV NAPPLET_CACHE_DIR=/opt/napplet-cache HOME=/home/napplet CI=1
RUN chmod 0555 /usr/local/bin/napplet && mkdir -p /work /output /home/napplet && chmod 0777 /work /output /home/napplet
# Fetch and verify the CLI's private Node, Paja and Chromium at image-build time.
# Captures themselves run with --network none and a read-only cache.
RUN napplet screenshot --help && chmod -R a+rX /opt/napplet-cache
COPY run.ts /opt/publication-runner.ts
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["timeout", "85s", "bun", "/opt/publication-runner.ts"]
