import { describe, expect, it } from "vitest";

import { decideRetry, resolveMaxAttempts, MAX_ATTEMPTS_CAP } from "../src/index.ts";

describe("resolveMaxAttempts", () => {
  it("defaults and clamps into the shared cap", () => {
    expect(resolveMaxAttempts(undefined)).toBe(3);
    expect(resolveMaxAttempts(Number.NaN)).toBe(3);
    expect(resolveMaxAttempts(0)).toBe(1);
    expect(resolveMaxAttempts(2.8)).toBe(2);
    expect(resolveMaxAttempts(99)).toBe(MAX_ATTEMPTS_CAP);
  });
});

describe("decideRetry", () => {
  it("retries the same step while attempts remain", () => {
    expect(decideRetry({ attempt: 1, maxAttempts: 3 })).toEqual({
      action: "retry",
      attemptsUsed: 1,
      maxAttempts: 3,
      nextAttempt: 2,
    });
  });

  it("fails closed once the cap is spent", () => {
    expect(decideRetry({ attempt: 3, maxAttempts: 3 })).toEqual({
      action: "fail",
      attemptsUsed: 3,
      maxAttempts: 3,
    });
  });
});
