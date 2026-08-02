import type { PrismaClient, Role } from "@prisma/client";
import { ForbiddenError, NotFoundError } from "../../../common/errors.js";
import { buildMeta, type PaginationQuery } from "../../../common/pagination.js";
import type { PageMeta } from "../../../common/response.js";
import type { UsersRepository } from "../../users/repositories/users.repository.js";
import type { WalletRepository } from "../../wallet/repositories/wallet.repository.js";
import type { RefreshTokenRepository } from "../../auth/repositories/refresh-token.repository.js";
import { toPublicUser, type PublicUser } from "../../users/schemas/users.schema.js";
import type {
  AdminReferralRow,
  AdminStats,
  ListReferralsQuery,
  ListUsersQuery,
} from "../schemas/admin.schema.js";

export class AdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UsersRepository,
    private readonly wallets: WalletRepository,
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  async stats(): Promise<AdminStats> {
    // Dashboard load used to open eleven concurrent Prisma queries. On a
    // serverless Postgres connection that amplified pool pressure and made the
    // first admin screen as slow as its slowest round trip. PostgreSQL can
    // compute the same independent aggregates in one request.
    const [row] = await this.prisma.$queryRaw<
      Array<{
        totalUsers: number;
        activeCampaigns: number;
        pendingClaims: number;
        approvedClaims: number;
        totalWalletBalance: number;
        pendingSubmissions: number;
        pendingRedemptions: number;
        coinsInPendingRedemptions: number;
        fulfilledRedemptions: number;
        pendingMissionCompletions: number;
        totalReferrals: number;
      }>
    >`
      SELECT
        (SELECT COUNT(*)::integer FROM users) AS "totalUsers",
        (SELECT COUNT(*)::integer FROM campaigns WHERE status = 'ACTIVE') AS "activeCampaigns",
        (SELECT COUNT(*)::integer FROM claims WHERE status = 'PENDING') AS "pendingClaims",
        (SELECT COUNT(*)::integer FROM claims WHERE status = 'APPROVED') AS "approvedClaims",
        COALESCE((SELECT SUM(balance)::double precision FROM wallets), 0) AS "totalWalletBalance",
        (SELECT COUNT(*)::integer FROM offer_submissions WHERE status = 'PENDING') AS "pendingSubmissions",
        (SELECT COUNT(*)::integer FROM redemptions WHERE status = 'PENDING') AS "pendingRedemptions",
        COALESCE(
          (SELECT SUM(coins)::double precision FROM redemptions WHERE status = 'PENDING'),
          0
        ) AS "coinsInPendingRedemptions",
        (SELECT COUNT(*)::integer FROM redemptions WHERE status = 'FULFILLED') AS "fulfilledRedemptions",
        (SELECT COUNT(*)::integer FROM mission_completions WHERE status = 'PENDING') AS "pendingMissionCompletions",
        (SELECT COUNT(*)::integer FROM users WHERE "referredById" IS NOT NULL) AS "totalReferrals"
    `;

    // SELECT without a FROM always returns exactly one row, but retain an
    // explicit fallback so a mocked/aborted adapter cannot crash serialization.
    return (
      row ?? {
        totalUsers: 0,
        activeCampaigns: 0,
        pendingClaims: 0,
        approvedClaims: 0,
        totalWalletBalance: 0,
        pendingSubmissions: 0,
        pendingRedemptions: 0,
        coinsInPendingRedemptions: 0,
        fulfilledRedemptions: 0,
        pendingMissionCompletions: 0,
        totalReferrals: 0,
      }
    );
  }

  async listUsers(query: ListUsersQuery): Promise<{ items: PublicUser[]; meta: PageMeta }> {
    const pagination: PaginationQuery = { page: query.page, limit: query.limit };
    const [users, total] = await this.users.list({
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      search: query.search,
      role: query.role as Role | undefined,
    });
    return { items: users.map(toPublicUser), meta: buildMeta(pagination, total) };
  }

  async listReferrals(
    query: ListReferralsQuery,
  ): Promise<{ items: AdminReferralRow[]; meta: PageMeta }> {
    const pagination: PaginationQuery = { page: query.page, limit: query.limit };
    const [referred, total] = await this.users.listReferrals({
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      search: query.search,
      from: query.from,
      to: query.to,
    });

    // Credited points live in the referrer's ledger under "referral:<referredUserId>".
    const txs = await this.wallets.findByReferences(referred.map((u) => `referral:${u.id}`));
    const pointsByRef = new Map(txs.map((t) => [t.reference, t.amount.toNumber()]));

    const items: AdminReferralRow[] = referred.map((u) => ({
      referred: {
        id: u.id,
        name: u.name,
        email: u.email,
        referredAt: u.referredAt?.toISOString() ?? null,
      },
      referrer: u.referredBy
        ? {
            id: u.referredBy.id,
            name: u.referredBy.name,
            email: u.referredBy.email,
            referralCode: u.referredBy.referralCode,
          }
        : null,
      creditedPoints: pointsByRef.get(`referral:${u.id}`) ?? null,
    }));

    return { items, meta: buildMeta(pagination, total) };
  }

  async updateUserRole(actorRole: string, targetUserId: string, role: Role): Promise<PublicUser> {
    const target = await this.users.findById(targetUserId);
    if (!target) throw new NotFoundError("User not found");

    // Only a SUPER_ADMIN may grant or modify SUPER_ADMIN accounts.
    if ((role === "SUPER_ADMIN" || target.role === "SUPER_ADMIN") && actorRole !== "SUPER_ADMIN") {
      throw new ForbiddenError("Only a super admin can manage super admin roles");
    }

    const updated = await this.users.update(targetUserId, { role });
    return toPublicUser(updated);
  }

  async updateUserStatus(
    actorId: string,
    actorRole: string,
    targetUserId: string,
    isActive: boolean,
  ): Promise<PublicUser> {
    if (actorId === targetUserId) {
      throw new ForbiddenError("You cannot change your own account status");
    }

    const target = await this.users.findById(targetUserId);
    if (!target) throw new NotFoundError("User not found");
    if (target.role === "SUPER_ADMIN" && actorRole !== "SUPER_ADMIN") {
      throw new ForbiddenError("Only a super admin can manage super admin accounts");
    }

    const updated = await this.users.update(targetUserId, { isActive });

    // Deactivation revokes every active session immediately.
    if (!isActive) {
      await this.refreshTokens.revokeAllForUser(targetUserId);
    }
    return toPublicUser(updated);
  }
}
