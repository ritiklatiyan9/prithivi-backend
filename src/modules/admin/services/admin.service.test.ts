import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { RefreshTokenRepository } from "../../auth/repositories/refresh-token.repository.js";
import type { UsersRepository } from "../../users/repositories/users.repository.js";
import type { WalletRepository } from "../../wallet/repositories/wallet.repository.js";
import { AdminService } from "./admin.service.js";

describe("admin dashboard stats", () => {
  it("loads every counter in one database round trip", async () => {
    const expected = {
      totalUsers: 100,
      activeCampaigns: 2,
      pendingClaims: 3,
      approvedClaims: 40,
      totalWalletBalance: 12_345.5,
      pendingSubmissions: 4,
      pendingRedemptions: 5,
      coinsInPendingRedemptions: 600,
      fulfilledRedemptions: 7,
      pendingMissionCompletions: 8,
      totalReferrals: 9,
    };
    const queryRaw = vi.fn(async () => [expected]);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
    const service = new AdminService(
      prisma,
      {} as UsersRepository,
      {} as WalletRepository,
      {} as RefreshTokenRepository,
    );

    await expect(service.stats()).resolves.toEqual(expected);
    expect(queryRaw).toHaveBeenCalledOnce();
  });
});
