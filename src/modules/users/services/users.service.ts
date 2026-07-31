import { Prisma, type PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../../../common/errors.js";
import type { UsersRepository } from "../repositories/users.repository.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import {
  toPublicUser,
  type ProgressDto,
  type PublicUser,
  type UpdateProfileInput,
} from "../schemas/users.schema.js";

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
        data: { referredById: null, referredAt: null },
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
  ): Promise<{ applied: true; rewardPoints: number }> {
    const caller = await this.users.findById(userId);
    if (!caller) throw new NotFoundError("User not found");
    if (caller.referredById) throw new ConflictError("A referral code has already been applied");

    const referrer = await this.users.findByReferralCode(code);
    if (!referrer) throw new NotFoundError("Referral code not found");
    if (referrer.id === caller.id) {
      throw new ConflictError("You cannot apply your own referral code");
    }

    const rewardPoints = await this.settings.getNumber("referral.rewardPoints");

    // Mark the caller referred + credit the referrer atomically. The guarded
    // updateMany (referredById still null) makes concurrent applies lose the
    // race and roll back their credit instead of double-crediting.
    await this.prisma.$transaction(async (tx) => {
      const marked = await tx.user.updateMany({
        where: { id: caller.id, referredById: null },
        data: { referredById: referrer.id, referredAt: new Date() },
      });
      if (marked.count === 0) {
        throw new ConflictError("A referral code has already been applied");
      }

      const wallet = await tx.wallet.upsert({
        where: { userId: referrer.id },
        create: { userId: referrer.id },
        update: {},
      });

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: rewardPoints } },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "CREDIT",
          amount: new Prisma.Decimal(rewardPoints),
          balanceAfter: updated.balance,
          reference: `referral:${caller.id}`,
          description: "Referral bonus",
        },
      });
    });

    // Best-effort: a Redis outage must not 500 an already-applied referral.
    try {
      await this.notifications.enqueue({
        userId: referrer.id,
        type: "WALLET",
        title: "Referral bonus",
        body: `You earned ${rewardPoints} for inviting ${caller.name}`,
      });
    } catch {
      /* push is best-effort */
    }

    return { applied: true, rewardPoints };
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
  async getReferralStats(
    userId: string,
  ): Promise<{
    referralCode: string | null;
    referredCount: number;
    coinsEarned: number;
    hasApplied: boolean;
  }> {
    const [user, stats] = await Promise.all([
      this.users.findById(userId),
      this.users.referralStats(userId),
    ]);
    if (!user) throw new NotFoundError("User not found");
    const withCode = await this.users.ensureReferralCode(user);
    return {
      ...stats,
      referralCode: withCode.referralCode,
      hasApplied: withCode.referredById !== null,
    };
  }
}
