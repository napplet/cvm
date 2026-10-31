FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts ./scripts
COPY vendor ./vendor
COPY migrations ./migrations

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
WORKDIR /app
ENV NODE_ENV=production
ENV TMPDIR=/tmp/napplet-cvm
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/vendor ./vendor
COPY --from=build /app/migrations ./migrations
RUN chmod -R go-w /app && mkdir -p /tmp/napplet-cvm && chown 65532:65532 /tmp/napplet-cvm && chmod 0700 /tmp/napplet-cvm
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD bun -e 'fetch("http://127.0.0.1:8080/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
ENTRYPOINT ["bun", "scripts/production.ts"]
