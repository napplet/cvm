FROM otel/opentelemetry-collector@sha256:6ed874ea083d67a3085acfc75343f2ad11d9abe6006d7ea4a16e2dba9af14e49
COPY --chmod=0444 infra/otel/collector.yaml /etc/otelcol/config.yaml
USER 10001:10001
EXPOSE 4318
CMD ["--config=/etc/otelcol/config.yaml"]
