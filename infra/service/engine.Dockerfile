# Dedicated build engine for untrusted generated code. The service talks to it
# over a private Unix socket; the host Docker socket is never exposed. Worker
# containers run under gVisor (runsc) with no network, dropped capabilities and
# resource limits enforced by the worker adapter.
FROM docker:29.9.2-dind@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977
# Upstream gvisor.tar.bz2.sha512: 9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e
ADD --checksum=sha256:180dd277f657c1478f09490e8a9a595f7378257510b43d1d3694a769aef9ed02 \
  https://storage.googleapis.com/gvisor/releases/release/20261012/x86_64/gvisor.tar.bz2 /tmp/gvisor.tar.bz2
RUN mkdir /tmp/gvisor && tar -xjf /tmp/gvisor.tar.bz2 -C /tmp/gvisor \
  && install -m 0755 /tmp/gvisor/runsc /tmp/gvisor/containerd-shim-runsc-v1 /usr/local/bin/ \
  && mkdir -p /usr/local/bin/gvisor-bin && install -m 0755 /tmp/gvisor/gvisor-bin/* /usr/local/bin/gvisor-bin/ \
  && rm -rf /tmp/gvisor /tmp/gvisor.tar.bz2 && /usr/local/bin/runsc --version
COPY infra/service/engine-daemon.json /etc/docker/daemon.json
