import { expect, test } from "bun:test";
import { ChatGptDiagnosticSchema, classifyChatGptFailure } from "../../src/dev/chatgpt-diagnostic";
import { chatGptErrorMessage } from "../../src/dev-ui/browser/chatgpt-settings";

test("generic provider failures never instruct the user to repeat OAuth", () => {
  for (const code of ["CHATGPT_REQUEST_FAILED", "CHATGPT_GENERATION_TIMEOUT", "CHATGPT_CONNECTION_FAILED"]) {
    expect(chatGptErrorMessage(code)).not.toContain("Continue with ChatGPT");
    expect(chatGptErrorMessage(code)).not.toContain("setup could not complete");
  }
  expect(chatGptErrorMessage("CHATGPT_GENERATION_TIMEOUT")).toContain("model time limit");
  expect(chatGptErrorMessage("CHATGPT_REAUTHORIZE_REQUIRED")).toContain("new sign-in");
  expect(chatGptErrorMessage("private bearer https://secret.invalid")).not.toContain("secret.invalid");
});

test("bounded diagnostics distinguish local aborts, invalid responses and recording failures", () => {
  const controller = new AbortController(); controller.abort();
  expect(classifyChatGptFailure(new Error("untrusted detail"), "stream", controller.signal)).toBe("CHATGPT_GENERATION_ABORTED");
  expect(classifyChatGptFailure(new SyntaxError("invalid JSON body"), "stream")).toBe("CHATGPT_RESPONSE_INVALID");
  expect(classifyChatGptFailure(new Error("CHATGPT_PLAN_ACCESS_DENIED"), "request")).toBe("CHATGPT_PLAN_ACCESS_DENIED");
  expect(ChatGptDiagnosticSchema.safeParse({ code: "CHATGPT_GENERATION_TIMEOUT", phase: "stream", elapsedMs: 300000, receivedBytes: 0, body: "private" }).success).toBe(false);
});
