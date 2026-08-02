import { describe, expect, it } from "vitest";
import { envBoolean } from "./env.js";

describe("environment boolean parsing", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
    [true, true],
    [false, false],
  ])("parses %j as %j", (input, expected) => {
    expect(envBoolean.parse(input)).toBe(expected);
  });

  it("rejects ambiguous non-boolean strings", () => {
    expect(() => envBoolean.parse("yes")).toThrow();
  });
});
