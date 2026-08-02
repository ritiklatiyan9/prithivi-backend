import { describe, expect, it, vi } from "vitest";
import type { SettingsRepository } from "../repositories/settings.repository.js";
import { SETTINGS_BY_KEY } from "../schemas/settings.schema.js";
import { SettingsService } from "./settings.service.js";

describe("retired roulette probability setting contract", () => {
  it("is absent from settings metadata and rejects legacy mutations", async () => {
    let writes = 0;
    const repo = {
      findAll: async () => [],
      upsertMany: async () => {
        writes += 1;
      },
    } as unknown as SettingsRepository;
    const service = new SettingsService(repo);

    expect(SETTINGS_BY_KEY["game.roulette.probabilityMode"]).toBeUndefined();
    await expect(
      service.update({ values: { "game.roulette.probabilityMode": "WEIGHTED" } }, "admin-id"),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
    });
    expect(writes).toBe(0);
  });
});

describe("roulette reset timezone validation", () => {
  it("rejects an invalid IANA timezone before persisting it", async () => {
    let writes = 0;
    const repo = {
      findAll: async () => [],
      upsertMany: async () => {
        writes += 1;
      },
    } as unknown as SettingsRepository;
    const service = new SettingsService(repo);

    await expect(
      service.update({ values: { "game.roulette.resetTimezone": "Not/A_Timezone" } }, "admin-id"),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
    });
    expect(writes).toBe(0);
  });

  it("falls back safely when a legacy override contains an invalid timezone", async () => {
    const repo = {
      findAll: async () => [
        {
          key: "game.roulette.resetTimezone",
          value: "Not/A_Timezone",
        },
      ],
    } as unknown as SettingsRepository;
    const service = new SettingsService(repo);

    await expect(service.getString("game.roulette.resetTimezone")).resolves.toBe("Asia/Kolkata");
  });
});

describe("roulette numeric setting contracts", () => {
  it("rejects fractional payout multipliers before they can reach an Int round column", async () => {
    let writes = 0;
    const repo = {
      findAll: async () => [],
      upsertMany: async () => {
        writes += 1;
      },
    } as unknown as SettingsRepository;
    const service = new SettingsService(repo);

    await expect(
      service.update({ values: { "game.roulette.payout.red": "1.5" } }, "admin-id"),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
    });
    expect(writes).toBe(0);
  });

  it("falls back to the registry default for a pre-existing fractional override", async () => {
    const repo = {
      findAll: async () => [
        {
          key: "game.roulette.payout.red",
          value: "1.5",
        },
      ],
    } as unknown as SettingsRepository;
    const service = new SettingsService(repo);

    await expect(service.getNumber("game.roulette.payout.red")).resolves.toBe(1);
  });
});

describe("settings cache", () => {
  it("coalesces concurrent cold reads into one database query", async () => {
    const findAll = vi.fn(async () => [
      { key: "redeem.enabled", value: "true" },
      { key: "redeem.minCoins", value: "250" },
    ]);
    const repo = {
      findAll,
      upsertMany: async () => undefined,
    } as unknown as SettingsRepository;
    const service = new SettingsService(repo);

    await expect(
      Promise.all([
        service.getBoolean("redeem.enabled"),
        service.getNumber("redeem.minCoins"),
        service.getBoolean("redeem.enabled"),
      ]),
    ).resolves.toEqual([true, 250, true]);
    expect(findAll).toHaveBeenCalledTimes(1);
  });

  it("does not restore an old snapshot when an admin update races a cache load", async () => {
    let releaseFirstLoad!: (rows: Array<{ key: string; value: string }>) => void;
    const firstLoad = new Promise<Array<{ key: string; value: string }>>((resolve) => {
      releaseFirstLoad = resolve;
    });
    const findAll = vi
      .fn()
      .mockImplementationOnce(() => firstLoad)
      .mockResolvedValueOnce([{ key: "redeem.enabled", value: "false" }]);
    const repo = {
      findAll,
      upsertMany: async () => undefined,
    } as unknown as SettingsRepository;
    const service = new SettingsService(repo);

    const oldRead = service.getBoolean("redeem.enabled");
    await service.update({ values: { "redeem.enabled": "false" } }, "admin-id");
    releaseFirstLoad([{ key: "redeem.enabled", value: "true" }]);

    await expect(oldRead).resolves.toBe(false);
    await expect(service.getBoolean("redeem.enabled")).resolves.toBe(false);
    expect(findAll).toHaveBeenCalledTimes(2);
  });
});
