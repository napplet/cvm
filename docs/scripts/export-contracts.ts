import { GenerationEstimatesSchema } from "../../src/dev-ui/generation-estimates-contract";
import { z } from "zod";
import * as core from "../../src/contextvm/adapter";
import { ProjectsArgumentsSchema } from "../../src/dev/projects";
import { DevelopmentPublicationArgumentsSchema } from "../../src/dev/local-publication";
import { RemixImportArgumentsSchema } from "../../src/dev/remix-imports";
import { CvmAdminArgumentsSchema } from "../../src/dev/cvm-operator";
import * as extra from "../../src/dev-ui/extension-schemas";
import { SessionActionResultSchema } from "../../src/phase-04/metered-generation-service";
import { SessionStatusSchema } from "../../src/phase-04/session-status";
import { DevelopmentProgressSchema } from "../../src/dev-ui/progress-contract";
import { ModelProfileSchema, PriceCardSchema } from "../../src/model/price-card";

const entries: [string, string, z.ZodType, string][] = [
  ["account_status", "Read balances for the signed request identity.", core.AccountStatusArgumentsSchema, "core"],
  ["top_up", "Start or submit a separate CEP-8 funding operation.", core.TopUpArgumentsSchema, "core"],
  ["funded_admission", "Reserve capacity and a sat-denominated cap before work.", core.FundedAdmissionArgumentsSchema, "core"],
  ["start_session", "Generate an applet after admission, or save a development pending action.", core.StartSessionArgumentsSchema, "core"],
  ["revise_session", "Create a metered revision of an owned session at the expected version.", core.ReviseSessionArgumentsSchema, "core"],
  ["resume_session", "Explicitly approve continuation of one exact pending action.", core.ResumeSessionArgumentsSchema, "core"],
  ["session_status", "Read owner-scoped session state and billing, or a pending action.", core.SessionStatusArgumentsSchema, "core"],
  ["preview", "Read a verified artifact descriptor or its capability review.", core.PreviewArgumentsSchema, "core"],
  ["publication", "Coordinate owner-signed publication when the promoted facade is installed.", core.PublicationArgumentsSchema, "core-optional"],
  ["service_info", "Read development mode, availability, required ceilings and caller-scoped historical estimates.", extra.ServiceInfoArgumentsSchema, "development"],
  ["development_faucet", "Mint local test Cashu; never real money.", extra.DevelopmentFaucetArgumentsSchema, "development"],
  ["projects", "List, read or rename projects belonging to the signed request identity.", ProjectsArgumentsSchema, "development"],
  ["remix_import", "Validate a signed applet and import isolated source or staged HTML.", RemixImportArgumentsSchema, "development"],
  ["development_publication", "Prepare and submit the user-signed development publication flow.", DevelopmentPublicationArgumentsSchema, "development"],
  ["operation_diagnostic", "Read bounded diagnostics for an owned model operation.", extra.OperationDiagnosticArgumentsSchema, "development"],
  ["cvm_admin", "Private operator configuration and job inspection; operator key required.", CvmAdminArgumentsSchema, "operator"],
];
const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", target: "draft-7" });
const value = {
  format: "napplet-cvm-contract-catalog-v1", sdkVersion: "0.13.10", mcpSdkVersion: "1.30.0",
  note: "Generated structural input schemas. Runtime refinements, signatures, ownership, availability, money ceilings, URL policy and durable state remain authoritative. A listed tool is not proof its facade is installed. This catalog format is not a wire protocol negotiation version.",
  tools: entries.map(([name, description, schema, scope]) => ({ name, description, scope, inputSchema: json(schema) })),
  results: { generationEstimates: json(GenerationEstimatesSchema), sessionAction: json(SessionActionResultSchema), sessionStatus: json(SessionStatusSchema), developmentProgress: json(DevelopmentProgressSchema) },
  operatorConfiguration: { modelProfile: json(ModelProfileSchema), priceCard: json(PriceCardSchema) },
};
const path = new URL("../public/contracts/napplet-cvm-v1.json", import.meta.url);
const content = JSON.stringify(value, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (await Bun.file(path).text() !== content) throw new Error("Contract catalog is stale. Run bun docs/scripts/export-contracts.ts");
} else await Bun.write(path, content);
console.log(`Contract catalog ${process.argv.includes("--check") ? "verified" : "written"}: ${entries.length} tools`);
