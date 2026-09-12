import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../common/errors.js";
import type { UsersRepository } from "../repositories/users.repository.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import {
  toPublicUser,
  type ProgressDto,
  type PublicUser,
  type UpdateProfileInput,
} from "../schemas/users.schema.js";

import { readReferralPolicy, type ReferralPolicy } from "./referral-policy.js";

const DEFAULT_RANKS = [
  "Bronze Scout",
  "Silver Hunter",
  "Gold Raider",
  "Platinum Elite",
  "Diamond Legend",
  "Mythic Champion",
];

/**
 * Level/rank math driven by LIFETIME COINS (sum of wallet CREDITs).
 * Quadratic (default base 100): level = floor(sqrt(coins/base)) + 1, i.e. a
 * new user is level 1 and reaching level n+1 needs base*n*n total coins —
 * identical to the client's PlayerProgress.fromBalance. Table mode:
 * thresholds[i] is the total coins to reach level i+2 (index 0 => level 2).
 */
export function computeProgress(coins: number, curveJson: string, ranksJson: string): ProgressDto {
  const safeCoins = Math.max(0, Math.floor(coins));

  let curve: { type?: string; base?: unknown; thresholds?: unknown } = {};
  try {
    curve = JSON.parse(curveJson);
  } catch {
    /* fall through to quadratic default — a bad setting must never 500 */
  }

  let level: number;
  let currentFloor: number;
  let nextFloor: number | null;
  if (curve.type === "table" && Array.isArray(curve.thresholds) && curve.thresholds.length > 0) {
    const thresholds = curve.thresholds.map(Number).filter(Number.isFinite);
    level = 1;
    while (level - 1 < thresholds.length && safeCoins >= thresholds[level - 1]) level++;
    currentFloor = level > 1 ? thresholds[level - 2] : 0;
    nextFloor = level - 1 < thresholds.length ? thresholds[level - 1] : null; // null = maxed
  } else {
    const base =
      typeof curve.base === "number" && Number.isFinite(curve.base) && curve.base > 0
        ? curve.base
        : 100;
    level = Math.max(1, Math.floor(Math.sqrt(safeCoins / base)) + 1);
    currentFloor = (level - 1) * (level - 1) * base;
    nextFloor = level * level * base;
  }

  let ranks = DEFAULT_RANKS;
  try {
    const parsed = JSON.parse(ranksJson);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((r) => typeof r === "string")) {
      ranks = parsed;
    }
  } catch {
    /* keep defaults */
  }
  const rankIndex = Math.min(Math.floor((level - 1) / 5), ranks.length - 1);

  return {
    coins: safeCoins,
    level,
    coinsInLevel: safeCoins - currentFloor,
    coinsForLevel: nextFloor === null ? 0 : nextFloor - currentFloor,
    rank: ranks[rankIndex],
    nextRank: rankIndex + 1 < ranks.length ? ranks[rankIndex + 1] : null,
  };
}

export class UsersService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UsersRepository,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly app: FastifyInstance,
  ) {}

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError("User not found");
    return toPublicUser(user);
  }

  async updateProfile(userId: string, input: UpdateProfileInput): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError("User not found");

    const updated = await this.users.update(userId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      ...(input.upiId !== undefined ? { upiId: input.upiId } : {}),
    });
    return toPublicUser(updated);
  }

  /**
   * Permanently deletes a consumer account and its associated activity.
   * Reviewer references are nulled first because those relations deliberately
   * use Restrict; user-owned rows then cascade from the User deletion.
   */
  async deleteAccount(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError("User not found");
    if (user.role !== "USER") {
      throw new ForbiddenError("Staff accounts must be transferred before deletion");
    }

    if (user.firebaseUid) {
      if (!this.app.firebaseAuth) {
        throw new AppError(
          "Account deletion is temporarily unavailable",
          503,
          "FIREBASE_NOT_CONFIGURED",
        );
      }
      try {
        await this.app.firebaseAuth.deleteUser(user.firebaseUid);
      } catch (error) {
        if ((error as { code?: string }).code !== "auth/user-not-found") throw error;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { referredById: userId },
        // Preserve the one-time claim marker even if the inviter deletes their account.
        data: { referredById: null },
      });
      await Promise.all([
        tx.claim.updateMany({ where: { reviewedById: userId }, data: { reviewedById: null } }),
        tx.offerSubmission.updateMany({
          where: { reviewedById: userId },
          data: { reviewedById: null },
        }),
        tx.redemption.updateMany({
          where: { reviewedById: userId },
          data: { reviewedById: null },
        }),
        tx.missionCompletion.updateMany({
          where: { reviewedById: userId },
          data: { reviewedById: null },
        }),
        tx.offerEvent.deleteMany({ where: { userId } }),
        tx.auditLog.deleteMany({
          where: { OR: [{ userId }, { userEmail: user.email }] },
        }),
        tx.pushLog.deleteMany({ where: { userId } }),
      ]);
      await tx.user.delete({ where: { id: userId } });
    });
  }

  async getProgress(userId: string): Promise<ProgressDto> {
    const [credited, curveJson, ranksJson] = await Promise.all([
      // Lifetime coins = every CREDIT ever received; debits/redemptions never
      // lower a player's level.
      this.prisma.walletTransaction.aggregate({
        where: { type: "CREDIT", wallet: { userId } },
        _sum: { amount: true },
      }),
      this.settings.getString("levels.curve"),
      this.settings.getString("levels.ranks"),
    ]);
    return computeProgress(Number(credited._sum.amount ?? 0), curveJson, ranksJson);
  }

  async applyReferral(
    userId: string,
    code: string,
  ): Promise<{
    applied: true;
    alreadyApplied: boolean;
    rewardPoints: number;
    inviteeRewardPoints: number;
  }> {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,16}$/.test(normalized))
      throw new BadRequestError("Enter a valid referral code");
    const referrer = await this.users.findByReferralCode(normalized);
    if (!referrer) throw new NotFoundError("Referral code not found");
    if (referrer.id === userId) throw new ConflictError("You cannot apply your own referral code");

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock both accounts in deterministic order: concurrent retries, different
      // codes and reciprocal invitations cannot race eligibility or deletion.
      const accounts = await tx.$queryRaw<
        Array<{
          id: string;
          name: string;
          isActive: boolean;
          referredById: string | null;
          referredAt: Date | null;
        }>
      >`SELECT id, name, "isActive", "referredById", "referredAt"
          FROM users WHERE id IN (${userId}, ${referrer.id}) ORDER BY id FOR UPDATE`;
      const caller = accounts.find((u) => u.id === userId);
      const inviter = accounts.find((u) => u.id === referrer.id);
      if (!caller) throw new NotFoundError("User not found");
      if (!caller.isActive) throw new ForbiddenError("This account cannot apply referral codes");

      // A retry after a lost response returns the original receipt, even if an
      // admin has since changed the amounts or paused the referral programme.
      if (caller.referredById === referrer.id) {
        const entries = await tx.walletTransaction.findMany({
          where: { reference: { in: [`referral:${userId}`, `referral-join:${userId}`] } },
          select: { reference: true, amount: true },
        });
        const amounts = new Map(entries.map((e) => [e.reference, Number(e.amount)]));
        return {
          applied: true as const,
          alreadyApplied: true,
          rewardPoints: amounts.get(`referral:${userId}`) ?? 0,
          inviteeRewardPoints: amounts.get(`referral-join:${userId}`) ?? 0,
        };
      }
      if (caller.referredById || caller.referredAt)
        throw new ConflictError("A referral code has already been applied");
      if (!inviter || !inviter.isActive)
        throw new ConflictError("This referral code is no longer available");
      if (inviter.referredById === caller.id)
        throw new ConflictError("You cannot exchange referral codes with someone you invited");
      const policy = await readReferralPolicy(tx);
      if (!policy.enabled) throw new ConflictError("Referrals are paused. Please try again later");

      const marked = await tx.user.updateMany({
        where: { id: userId, referredById: null, referredAt: null, isActive: true },
        data: { referredById: referrer.id, referredAt: new Date() },
      });
      if (marked.count !== 1) throw new ConflictError("A referral code has already been applied");

      const credits = [
        {
          userId: referrer.id,
          amount: policy.rewardPoints,
          reference: `referral:${userId}`,
          description: "Friend invitation reward",
        },
        {
          userId,
          amount: policy.inviteeRewardPoints,
          reference: `referral-join:${userId}`,
          description: "Joining referral reward",
        },
      ].sort((a, b) => a.userId.localeCompare(b.userId));
      for (const credit of credits) {
        const wallet = await tx.wallet.upsert({
          where: { userId: credit.userId },
          create: { userId: credit.userId },
          update: {},
        });
        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: credit.amount } },
        });
        // Zero-value entries retain the claim's original terms for retries and
        // admin history; a later reward increase must not change an old claim.
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: "CREDIT",
            amount: new Prisma.Decimal(credit.amount),
            balanceAfter: updated.balance,
            reference: credit.reference,
            description: credit.description,
          },
        });
      }
      return {
        applied: true as const,
        alreadyApplied: false,
        rewardPoints: policy.rewardPoints,
        inviteeRewardPoints: policy.inviteeRewardPoints,
      };
    });

    if (!result.alreadyApplied) {
      // Notifications are best-effort and never turn a committed reward into
      // an error that encourages another claim.
      await Promise.allSettled([
        ...(result.rewardPoints > 0
          ? [
              this.notifications.enqueue({
                userId: referrer.id,
                type: "WALLET",
                title: "Your invitation paid off",
                body: `A friend joined with your code. ${result.rewardPoints} coins were added to your wallet.`,
              }),
            ]
          : []),
        ...(result.inviteeRewardPoints > 0
          ? [
              this.notifications.enqueue({
                userId,
                type: "WALLET",
                title: "Welcome reward",
                body: `${result.inviteeRewardPoints} referral coins were added to your wallet.`,
              }),
            ]
          : []),
      ]);
    }
    return result;
  }

  /**
   * Today's top-10 earners (coins credited since midnight IST — the user
   * base's local day). ponytail: IST offset hardcoded; make it a setting if
   * the app ever leaves India.
   */
  async getDailyLeaderboard(): Promise<
    Array<{ rank: number; name: string; avatarUrl: string | null; coins: number }>
  > {
    const IST_OFFSET_MS = 5.5 * 3_600_000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    istNow.setUTCHours(0, 0, 0, 0);
    const dayStartUtc = new Date(istNow.getTime() - IST_OFFSET_MS);

    const top = await this.users.topEarnersSince(dayStartUtc, 10);
    return top.map((entry, index) => ({
      rank: index + 1,
      name: entry.user.name,
      avatarUrl: entry.user.avatarUrl,
      coins: entry.coins,
    }));
  }

  /** Sharer-facing referral stats + whether this user already applied a code.
   *  Also backfills a missing referralCode so Share & Earn always has one. */
  async getReferralStats(userId: string): Promise<{
    referralCode: string | null;
    referredCount: number;
    coinsEarned: number;
    hasApplied: boolean;
    policy: ReferralPolicy;
  }> {
    const [user, stats, policy] = await Promise.all([
      this.users.findById(userId),
      this.users.referralStats(userId),
      readReferralPolicy(this.prisma),
    ]);
    if (!user) throw new NotFoundError("User not found");
    const withCode = await this.users.ensureReferralCode(user);
    return {
      ...stats,
      referralCode: withCode.referralCode,
      hasApplied: withCode.referredById !== null || withCode.referredAt !== null,
      policy,
    };
  }
}
