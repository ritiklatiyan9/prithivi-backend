import { Prisma } from "@prisma/client";
import type { PrismaClient, Wallet, WalletTransaction } from "@prisma/client";

export class WalletRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findByUserId(userId: string): Promise<Wallet | null> {
    return this.prisma.wallet.findUnique({ where: { userId } });
  }

  async ensureForUser(userId: string): Promise<Wallet> {
    const existing = await this.findByUserId(userId);
    if (existing) return existing;
    return this.prisma.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  /** Atomically credits a wallet and records the transaction. */
  credit(params: {
    userId: string;
    amount: Prisma.Decimal | number;
    reference?: string;
    description?: string;
  }): Promise<WalletTransaction> {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { userId: params.userId },
        create: { userId: params.userId },
        update: {},
      });

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: params.amount } },
      });

      return tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "CREDIT",
          amount: new Prisma.Decimal(params.amount),
          balanceAfter: updated.balance,
          reference: params.reference,
          description: params.description,
        },
      });
    });
  }

  listTransactions(
    walletId: string,
    params: { skip: number; take: number },
  ): Promise<[WalletTransaction[], number]> {
    return Promise.all([
      this.prisma.walletTransaction.findMany({
        where: { walletId },
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.walletTransaction.count({ where: { walletId } }),
    ]);
  }

  /** Ledger rows by reference key, e.g. "referral:<userId>". */
  findByReferences(references: string[]): Promise<WalletTransaction[]> {
    if (references.length === 0) return Promise.resolve([]);
    return this.prisma.walletTransaction.findMany({ where: { reference: { in: references } } });
  }

  totalBalance(): Promise<Prisma.Decimal | null> {
    return this.prisma.wallet
      .aggregate({ _sum: { balance: true } })
      .then((result) => result._sum.balance);
  }

  // ---- derived wallet stats (Module 5) — computed from the ledger so they
  //      can never drift from the source of truth ----

  async ledgerStats(walletId: string): Promise<{
    credited: Prisma.Decimal;
    withdrawn: Prisma.Decimal;
    rewardCount: number;
  }> {
    const rows = await this.prisma.walletTransaction.groupBy({
      by: ["type"],
      where: { walletId },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const credits = rows.find((row) => row.type === "CREDIT");
    const debits = rows.find((row) => row.type === "DEBIT");
    return {
      credited: credits?._sum.amount ?? new Prisma.Decimal(0),
      withdrawn: debits?._sum.amount ?? new Prisma.Decimal(0),
      rewardCount: credits?._count._all ?? 0,
    };
  }

  /** Lifetime earnings = sum of all credits; rewardCount = number of credits. */
  async creditStats(walletId: string): Promise<{ total: Prisma.Decimal; count: number }> {
    const result = await this.prisma.walletTransaction.aggregate({
      where: { walletId, type: "CREDIT" },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return { total: result._sum.amount ?? new Prisma.Decimal(0), count: result._count._all };
  }

  /** Total withdrawn = sum of all debits (withdrawals debit the wallet). */
  async debitTotal(walletId: string): Promise<Prisma.Decimal> {
    const result = await this.prisma.walletTransaction.aggregate({
      where: { walletId, type: "DEBIT" },
      _sum: { amount: true },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }

  /** Pending rewards = reward value of the user's not-yet-approved submissions. */
  async pendingRewardsForUser(userId: string): Promise<Prisma.Decimal> {
    const result = await this.prisma.offerSubmission.aggregate({
      where: { userId, status: "PENDING" },
      _sum: { rewardAmount: true },
    });
    return result._sum.rewardAmount ?? new Prisma.Decimal(0);
  }
}
