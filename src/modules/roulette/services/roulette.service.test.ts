import { describe, expect, it, vi } from "vitest";
import { RouletteService } from "./roulette.service.js";

describe("retired probability profile activation contract", () => {
  it("returns an explicit 410 instead of accepting an ignored activation", async () => {
    const service = new RouletteService(null as never, null as never, null as never);

    await expect(
      service.activateProfile(
        { id: "admin-id", email: "admin@example.test" },
        "profile-id",
        "legacy activation attempt",
      ),
    ).rejects.toMatchObject({
      statusCode: 410,
      code: "ROULETTE_PROFILE_ACTIVATION_RETIRED",
    });
  });
});

describe("roulette advisory locks", () => {
  it("executes void-returning PostgreSQL locks without row deserialization", async () => {
    const executeRaw = vi.fn(async () => 0);
    const queryRaw = vi.fn();
    const transaction = { $executeRaw: executeRaw, $queryRaw: queryRaw };
    const service = new RouletteService(null as never, null as never, null as never) as unknown as {
      lockUserPlay(tx: typeof transaction, userId: string): Promise<void>;
      lockProbabilityPolicyRead(tx: typeof transaction): Promise<void>;
      lockProbabilityPolicyWrite(tx: typeof transaction): Promise<void>;
    };

    await service.lockUserPlay(transaction, "user-id");
    await service.lockProbabilityPolicyRead(transaction);
    await service.lockProbabilityPolicyWrite(transaction);

    expect(executeRaw).toHaveBeenCalledTimes(3);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
