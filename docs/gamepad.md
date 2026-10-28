# GAMEPAD authoring coverage

This non-normative guide defers to the living [NAP-GAMEPAD proposal](https://github.com/napplet/naps/pull/108) and [NIP-5D](https://github.com/nostr-protocol/nips/pull/2303).

Generation evidence accepts `gamepad` as required when controller input is essential, or through internal `declaredOptional` evidence for a controller enhancement. This internal evidence is not a new manifest field: publishing uses the canonical `R` or `O` domain tags. Required controllers must appear in the observed focused path; optional controller support can degrade to keyboard or pointer controls. Undeclared, duplicate, or contradictory evidence fails the CVM policy.

Generated app code uses a GAMEPAD-capable SDK and checks injected domain presence. Keep the fallback usable when controllers are unavailable or the frame lacks focus. Ignore gameplay button transitions while unfocused and establish a baseline on regained focus. Native controller access belongs to the runtime; generated code does not call `navigator.getGamepads()` or open HID devices.

The sealed toolchain and runtime compatibility identity still govern which package set can execute a generated artifact. These policy changes do not promote an image, bypass scanner/conformance findings, or declare old SDK/Paja versions GAMEPAD-capable. Promote a release set containing the GAMEPAD SDK, template, conformance engine, and compatible runtime through the existing candidate verification flow. Capability review reports missing required controllers as incompatible and missing optional controllers as degraded.
