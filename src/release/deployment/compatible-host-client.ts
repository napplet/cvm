import { z } from "zod";

import {
  CompatibleHostBrowserObservationPort,
  type CompatibleHostBrowserPort,
  type CompatibleHostPackagePort,
} from "../native/compatible-host";

const ReferenceSchema = z.string().regex(/^[a-z][a-z0-9:._/-]{2,255}$/iu);

/** Promoted reference-host/Chromium descriptor. Both dependencies are injected
 * so construction cannot browse an external host or spawn a browser. */
export function createCompatibleHostDeploymentClient(input: Readonly<{
  referenceHostReference: unknown;
  chromiumReference: unknown;
  packageHost: CompatibleHostPackagePort;
  browser: CompatibleHostBrowserPort;
}>) {
  const referenceHostReference = ReferenceSchema.safeParse(input.referenceHostReference);
  const chromiumReference = ReferenceSchema.safeParse(input.chromiumReference);
  if (!referenceHostReference.success || !chromiumReference.success
    || !referenceHostReference.data.startsWith("napplet:reference-host:")
    || !chromiumReference.data.startsWith("chromium:")) throw new Error("DEPLOYMENT_REFERENCE_HOST_INVALID");
  if (!input.packageHost || !input.browser) throw new Error("DEPLOYMENT_REFERENCE_HOST_INVALID");
  const adapter = new CompatibleHostBrowserObservationPort({ packageHost: input.packageHost, browser: input.browser });
  return Object.freeze({
    discovery: () => Object.freeze({ referenceHostReference: referenceHostReference.data, chromiumReference: chromiumReference.data, command: "pnpm verify && pnpm test:conformance" as const }),
    observe: adapter.runBrowser.bind(adapter),
  });
}
