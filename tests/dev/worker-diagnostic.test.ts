import { expect, test } from "bun:test";
import { parseWorkerDiagnostic, formatWorkerDiagnostic } from "../../src/dev/worker-diagnostic";
import { acceptDevelopmentProgress } from "../../src/dev-ui/progress-contract";

test("compiler diagnostics retain location and argument counts without raw output", () => {
  const diagnostic = parseWorkerDiagnostic("private build output\nsrc/main.ts(4,1): error TS2554: Expected 1 arguments, but got 0.\n");
  expect(diagnostic).toEqual({ file: "src/main.ts", line: 4, column: 1, code: "TS2554", arguments: { expected: 1, received: 0 } });
  expect(formatWorkerDiagnostic(diagnostic!)).toBe("src/main.ts:4:1 · TS2554: Expected 1 arguments, received 0.");
  const other = parseWorkerDiagnostic("src/main.ts(7,9): error TS2322: Type 'PRIVATE_MODEL_TEXT' is not assignable to type 'number'.");
  expect(formatWorkerDiagnostic(other!)).toBe("src/main.ts:7:9 · TS2322: Incompatible value type.");
  expect(JSON.stringify(other)).not.toContain("PRIVATE_MODEL_TEXT");
});

test("diagnostic parser rejects paths, malformed locations and arbitrary messages", () => {
  for (const line of ["/private/main.ts(1,2): error TS2554: secret", "src/../main.ts(1,2): error TS2554: secret", "src/main.ts(0,2): error TS2554: secret", "src/main.ts(99999,2): error TS2554: secret", "src/main.ts(1,2): error INJECTED: secret"]) expect(parseWorkerDiagnostic(line)).toBeUndefined();
  const diagnostic = parseWorkerDiagnostic("src/main.ts(1,2): error TS2554: <script>PRIVATE</script>");
  expect(diagnostic).toEqual({ file: "src/main.ts", line: 1, column: 2, code: "TS2554" });
  const event: NonNullable<ReturnType<typeof acceptDevelopmentProgress>> = { version: 1, requestId: "one", tool: "start_session", sequence: 2, at: 1, elapsedMs: 0, kind: "stage", stage: "verify", state: "failed", diagnostic };
  const pending = { id: "one", tool: "start_session", sequence: 1 };
  expect(acceptDevelopmentProgress(event, pending)).toEqual(event);
  for (const change of [{ message: "PRIVATE" }, { file: "../../private" }, { line: Infinity }, { code: "<script>" }]) expect(acceptDevelopmentProgress({ ...event, diagnostic: { ...diagnostic, ...change } }, pending)).toBeUndefined();
});
