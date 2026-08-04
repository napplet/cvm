import { requireDomain } from "@napplet/sdk";
import { useEffect, useState } from "react";

const storage = requireDomain("storage");

/** The sole direct shell observation: it chooses optional SDK composition, never invokes shell authority. */
export async function saveValue(value: string) {
  await storage.set("capability-harness-value", value);
  if (window.napplet?.intent) {
    const intent = requireDomain("intent");
    await intent.open({ value });
    return { mode: "primary" as const };
  }
  return { mode: "degraded-no-intent" as const, message: "Intent integration is unavailable; your value is still saved." };
}

export function App() {
  const [status, setStatus] = useState("Saving the fixture value…");

  useEffect(() => {
    void saveValue("capability-harness-fixture").then((result) => setStatus(
      result.mode === "primary" ? "Saved and opened intent." : result.message,
    ));
  }, []);

  return <main><h1>Capability harness</h1><p>Storage is required; intent is optional.</p><output>{status}</output></main>;
}
