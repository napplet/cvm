---
status: complete
---
# Screenshot and Zapstore publication

Use official CLI 0.10.0 (67d0e814100b9b54654168e525bfef74eff08c04) for publication media and application metadata. Keep existing verified artifacts and signatures compatible.

1. Add a pinned, offline, isolated publication worker. Capture a persistent PNG with the CLI screenshot command (the same engine as deploy --screenshot), then prepare the application with deploy --zapstore --dry-run. Cache bounded, hash-verified screenshot bytes per artifact, including existing builds, without model calls. Development setup builds/prewarms the image automatically.
2. Include screenshot files and a CLI-generated application template in CVM publication preparation. User signs both events in the browser. Mirror screenshots with the applet, publish application metadata before the applet, retain both signatures and delivery evidence for recovery and republication. Any one relay confirmation still publishes the applet; listing delivery is shown independently. No user private keys enter the CVM.
3. Show screenshot/signing/listing progress with concise UI, document behavior and compatibility limits with screenshots. Verify real Docker capture, two-copy/partial-relay publication, ownership, retry/restart, responsiveness and docs. Activate locally only when idle, commit and push main.

The build CLI remains pinned at 0.5.2 because current artifacts/Paja use legacy manifests. Publication tooling is independently pinned to 0.10.0; legacy events do not gain the proposed current-format app tag. The listing includes the napplet naddr in its description. Store catalog acceptance is external, not claimed by relay confirmation.
