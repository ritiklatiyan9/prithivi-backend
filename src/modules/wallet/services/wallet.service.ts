import { buildMeta, toSkipTake, type PaginationQuery } from "../../../common/pagination.js";
import type { PageMeta } from "../../../common/response.js";
import type { WalletRepository } from "../repositories/wallet.repository.js";
import {
  toWalletDto,
  toWalletTransactionDto,
  type WalletDto,
  type WalletSummaryDto,
  type WalletTransactionDto,
} from "../schemas/wallet.schema.js";

export class WalletService {
  constructor(private readonly wallets: WalletRepository) {}

  async getMyWallet(userId: string): Promise<WalletDto> {
    const wallet = await this.wallets.ensureForUser(userId);
    return toWalletDto(wallet);
  }

  /**
   * Rich wallet view. Every field is derived so it can never drift from the
   * ledger: lifetime/rewardCount from credits, totalWithdrawn from debits,
   * pending from PENDING submissions. lockedBalance stays 0 until the
   * Withdrawal module (6) reserves funds for in-flight requests.
   */
  async getMySummary(userId: string): Promise<WalletSummaryDto> {
    const wallet = await this.wallets.ensureForUser(userId);
    const [ledger, pending] = await Promise.all([
      this.wallets.ledgerStats(wallet.id),
      this.wallets.pendingRewardsForUser(userId),
    ]);

    const balance = wallet.balance.toNumber();
    const lockedBalance = 0; // Module 6: sum of active withdrawal requests

    return {
      balance,
      pendingRewards: pending.toNumber(),
      lifetimeEarnings: ledger.credited.toNumber(),
      totalWithdrawn: ledger.withdrawn.toNumber(),
      lockedBalance,
      withdrawableBalance: Math.max(0, balance - lockedBalance),
      rewardCount: ledger.rewardCount,
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  async getMyTransactions(
    userId: string,
    query: PaginationQuery,
  ): Promise<{ items: WalletTransactionDto[]; meta: PageMeta }> {
    const wallet = await this.wallets.ensureForUser(userId);
    const [transactions, total] = await this.wallets.listTransactions(wallet.id, toSkipTake(query));
    return {
      items: transactions.map(toWalletTransactionDto),
      meta: buildMeta(query, total),
    };
  }
}
