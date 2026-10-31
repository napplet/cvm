FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY scripts ./scripts
COPY vendor ./vendor
COPY migrations ./migrations

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS control
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

# Optional local report executable. The default final target below remains the
# original control image. Only this explicitly selected target includes Python.
FROM python:3.14.8-slim-trixie@sha256:9b629e83e1a517e01eaf7a36362563c0c7f620d3e4747f7dcf79564e290b7b48 AS modal-packages
RUN test "$(dpkg --print-architecture)" = amd64
COPY infra/production/modal-billing/requirements-linux-amd64.lock /opt/napplet-cvm-modal/requirements.lock
RUN python3 -I -m venv /opt/napplet-cvm-modal/venv \
    && /opt/napplet-cvm-modal/venv/bin/python -I -m pip --isolated download --index-url https://pypi.org/simple --only-binary=:all: --require-hashes --dest /tmp/modal-wheels -r /opt/napplet-cvm-modal/requirements.lock \
    && /opt/napplet-cvm-modal/venv/bin/python -I -m pip --isolated install --no-index --find-links /tmp/modal-wheels --only-binary=:all: --require-hashes -r /opt/napplet-cvm-modal/requirements.lock \
    && /opt/napplet-cvm-modal/venv/bin/python -I -m pip check \
    && rm -rf /tmp/modal-wheels /root/.cache \
    && chmod -R go-w /opt/napplet-cvm-modal

FROM python:3.14.8-slim-trixie@sha256:9b629e83e1a517e01eaf7a36362563c0c7f620d3e4747f7dcf79564e290b7b48 AS modal-billing
WORKDIR /app
ENV NODE_ENV=production TMPDIR=/tmp/napplet-cvm BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 PYTHONDONTWRITEBYTECODE=1
COPY --from=control /usr/local/bin/bun /usr/local/bin/bun
COPY --from=control /app /app
COPY --from=modal-packages /opt/napplet-cvm-modal /opt/napplet-cvm-modal
RUN mkdir -p /usr/local/bun-node-fallback-bin /tmp/napplet-cvm \
    && ln -s /usr/local/bin/bun /usr/local/bun-node-fallback-bin/node \
    && chown 65532:65532 /tmp/napplet-cvm && chmod 0700 /tmp/napplet-cvm \
    && chmod -R go-w /app /opt/napplet-cvm-modal
ENV PATH="/usr/local/bin:/usr/local/bun-node-fallback-bin:/usr/bin:/bin"
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD bun -e 'fetch("http://127.0.0.1:8080/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
ENTRYPOINT ["bun", "scripts/production.ts"]

# Preserve the existing default image and entrypoint.
FROM control AS production
