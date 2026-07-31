import { describe, expect, it } from "vitest";
import { isCorsOriginAllowed } from "./cors-origin.js";

describe("CORS origin allowlist", () => {
  it("always permits native/server clients without an Origin header", () => {
    expect(isCorsOriginAllowed(undefined, "", true)).toBe(true);
  });

  it("permits both canonical Money Marathon website hosts in production", () => {
    expect(isCorsOriginAllowed("https://moneymarathon.in", "", true)).toBe(true);
    expect(isCorsOriginAllowed("https://www.moneymarathon.in", "", true)).toBe(true);
  });

  it("normalizes harmless trailing slashes in configured origins", () => {
    expect(
      isCorsOriginAllowed("https://admin.example.com", "https://admin.example.com/", true),
    ).toBe(true);
  });

  it("rejects lookalike and unconfigured origins in production", () => {
    expect(isCorsOriginAllowed("https://www.moneymarathon.in.evil.test", "", true)).toBe(false);
    expect(isCorsOriginAllowed("https://evil.test", "", true)).toBe(false);
    expect(isCorsOriginAllowed("http://localhost:5174", "", true)).toBe(false);
  });

  it("permits localhost previews only outside production", () => {
    expect(isCorsOriginAllowed("http://localhost:5174", "", false)).toBe(true);
    expect(isCorsOriginAllowed("http://127.0.0.1:4173", "", false)).toBe(true);
  });
});
