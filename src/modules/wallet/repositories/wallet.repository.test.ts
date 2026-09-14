import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { WalletRepository } from "./wallet.repository.js";

describe("wallet read performance", () => {
  it("an existing wallet is read without an upsert or write lock", async () => {
    const wallet = { id: "wallet", balance: new Prisma.Decimal(470) };
    const upsert = vi.fn();
    const repo = new WalletRepository({
      wallet: {
        findUnique: vi.fn(async () => wallet),
        upsert,
      },
    } as unknown as PrismaClient);
    expect(await repo.ensureForUser("alice")).toBe(wallet);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("credit/debit totals share one aggregation, preserving exact decimal amounts", async () => {
    const groupBy = vi.fn(async () => [
      { type: "CREDIT", _sum: { amount: new Prisma.Decimal("470.25") }, _count: { _all: 4 } },
      { type: "DEBIT", _sum: { amount: new Prisma.Decimal("20.10") }, _count: { _all: 1 } },
    ]);
    const repo = new WalletRepository({
      walletTransaction: { groupBy },
    } as unknown as PrismaClient);
    const stats = await repo.ledgerStats("wallet");
    expect(stats.credited.toString()).toBe("470.25");
    expect(stats.withdrawn.toString()).toBe("20.1");
    expect(stats.rewardCount).toBe(4);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ["type"],
      where: { walletId: "wallet" },
      _sum: { amount: true },
      _count: { _all: true },
    });
  });
});
