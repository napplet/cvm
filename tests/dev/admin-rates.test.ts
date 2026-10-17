import { expect, test } from "bun:test";
import { displayPerThousand, rateFromPerThousand, exampleCharge } from "../../src/dev-ui/browser/admin-rates";

test("per-thousand prices convert exactly to the existing sat-per-token contract", () => {
  expect(rateFromPerThousand("1")).toEqual({ numerator: "1", denominator: "1000" });
  expect(rateFromPerThousand("0.5")).toEqual({ numerator: "1", denominator: "2000" });
  expect(rateFromPerThousand("1.25")).toEqual({ numerator: "1", denominator: "800" });
  expect(rateFromPerThousand("0.000001")).toEqual({ numerator: "1", denominator: "1000000000" });
  expect(rateFromPerThousand("999999999999.999999")).toEqual({ numerator: "999999999999999999", denominator: "1000000000" });
  for (const value of ["", "0", "0.000000", "-1", "Infinity", "1e3", "1,000", "01", "0.0000001", "1000000000000"]) expect(() => rateFromPerThousand(value)).toThrow();
});
test("display avoids floating point drift and identifies rates needing more precision", () => {
  expect(displayPerThousand({ numerator: "1", denominator: "2000" })).toEqual({ value: "0.5", approximate: false });
  expect(displayPerThousand({ numerator: "1", denominator: "3" })).toEqual({ value: "333.333334", approximate: true });
  expect(displayPerThousand({ numerator: "1", denominator: "1000000000000" })).toEqual({ value: "0.000001", approximate: true });
  expect(displayPerThousand({ numerator: "999999999999999999", denominator: "1000000000" })).toEqual({ value: "999999999999.999999", approximate: false });
});
test("example rounds each billed category up independently and excludes inactive rates", () => {
  const rates = { input_tokens: rateFromPerThousand("1"), output_tokens: rateFromPerThousand("1"), reasoning_tokens: rateFromPerThousand("999") };
  expect(exampleCharge(rates, ["input_tokens", "output_tokens"])).toBe("12");
  expect(exampleCharge({ ...rates, input_tokens: rateFromPerThousand("0.5") }, ["input_tokens", "output_tokens"])).toBe("7");
  expect(exampleCharge({ input_tokens: rateFromPerThousand("0.01"), output_tokens: rateFromPerThousand("0.01") }, ["input_tokens", "output_tokens"])).toBe("2");
});
