import { z } from "zod";

/** Only compiler identifiers and bounded locations cross the progress boundary. */
export const WorkerDiagnosticSchema = z.object({
  file: z.literal("src/main.ts"),
  line: z.number().int().min(1).max(64000), column: z.number().int().min(1).max(64000),
  code: z.string().regex(/^TS[0-9]{4,5}$/u),
  arguments: z.object({ expected: z.number().int().min(0).max(1000), received: z.number().int().min(0).max(1000) }).strict().optional(),
}).strict();
export type WorkerDiagnostic = z.infer<typeof WorkerDiagnosticSchema>;

export function parseWorkerDiagnostic(output: string): WorkerDiagnostic | undefined {
  for (const line of output.slice(-40000).split(/\r?\n/u)) {
    const match = /^src\/main\.ts\(([0-9]{1,5}),([0-9]{1,5})\): error (TS[0-9]{4,5}): (.*)$/u.exec(line);
    if (!match) continue;
    const args = match[3] === "TS2554" ? /^Expected ([0-9]{1,4}) arguments?, but got ([0-9]{1,4})\.$/u.exec(match[4]!) : null;
    const diagnostic = WorkerDiagnosticSchema.safeParse({ file: "src/main.ts", line: Number(match[1]), column: Number(match[2]), code: match[3], ...(args ? { arguments: { expected: Number(args[1]), received: Number(args[2]) } } : {}) });
    if (diagnostic.success) return diagnostic.data;
  }
}

export function formatWorkerDiagnostic(diagnostic: WorkerDiagnostic): string {
  const message = diagnostic.arguments ? `Expected ${diagnostic.arguments.expected} arguments, received ${diagnostic.arguments.received}.` : diagnostic.code === "TS2322" ? "Incompatible value type." : "Generated source did not pass TypeScript validation.";
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} · ${diagnostic.code}: ${message}`;
}
