import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Compatibility entrypoints contain declarations only. Implementations are operator-installed. */
export async function legacyPaymentModule(path: string, exports: readonly string[]): Promise<Record<string, unknown>> {
  const directory = process.env.NAPPLET_CVM_PAYMENT_IMPLEMENTATION_ROOT;
  if (!directory) return Object.fromEntries(exports.map(name => [name, function unavailable() { throw new Error("PAYMENT_ADAPTER_NOT_INSTALLED"); }]));
  if (!isAbsolute(directory) || path.includes("..")) throw new Error("PAYMENT_ADAPTER_ROOT_INVALID");
  return import(pathToFileURL(resolve(directory, path)).href);
}
