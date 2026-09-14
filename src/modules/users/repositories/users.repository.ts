import { Prisma, type PrismaClient, type Role, type User } from "@prisma/client";
import { randomInt } from "node:crypto";

export interface FirebaseProfile {
  firebaseUid: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

const REFERRAL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const generateReferralCode = (): string =>
  Array.from({ length: 8 }, () => REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)]).join("");

const isReferralCodeCollision = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002" &&
  String(error.meta?.target ?? "").includes("referralCode");

export class UsersRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByReferralCode(code: string): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: { referralCode: { equals: code, mode: "insensitive" } },
    });
  }

  async upsertFirebaseUser(profile: FirebaseProfile): Promise<{ user: User; isNewUser: boolean }> {
    // Match an existing account by Firebase UID or by verified email, then link
    // the UID — so users who previously signed in via Google keep one account.
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ firebaseUid: profile.firebaseUid }, { email: profile.email }] },
    });

    if (!existing) {
      // Collision-retry on the unique referralCode (36^8 space, so ~never loops).
      for (;;) {
        try {
          const user = await this.prisma.user.create({
            data: {
              firebaseUid: profile.firebaseUid,
              email: profile.email,
              name: profile.name,
              avatarUrl: profile.avatarUrl,
              referralCode: generateReferralCode(),
            },
          });
          return { user, isNewUser: true };
        } catch (error) {
          if (!isReferralCodeCollision(error)) throw error;
        }
      }
    }

    // Backfill referralCode for rows created before the referral feature —
    // otherwise Share & Earn is permanently disabled for them.
    for (;;) {
      try {
        const user = await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            firebaseUid: profile.firebaseUid,
            avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
          },
        });
        // A pre-created row (e.g. email-invited) that never signed in counts as new.
        return {
          user: await this.ensureReferralCode(user),
          isNewUser: existing.firebaseUid === null,
        };
      } catch (error) {
        if (!isReferralCodeCollision(error)) throw error;
      }
    }
  }

  /** Generates and saves a referralCode for a user that has none (pre-feature
   *  rows whose session predates the sign-in backfill). Returns the user. */
  async ensureReferralCode(user: User): Promise<User> {
    if (user.referralCode) return user;
    for (;;) {
      try {
        await this.prisma.user.updateMany({
          where: { id: user.id, referralCode: null },
          data: { referralCode: generateReferralCode() },
        });
        // A simultaneous request may have won. Return the stored code rather
        // than replacing a code another user has already copied or shared.
        return await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      } catch (error) {
        if (!isReferralCodeCollision(error)) throw error;
      }
    }
  }

  /**
   * Top earners since `since`: sums wallet CREDITs per user (refund credits
   * excluded — a refund isn't earning) and returns the users, ranked.
   */
  async topEarnersSince(
    since: Date,
    take: number,
  ): Promise<Array<{ user: Pick<User, "name" | "avatarUrl">; coins: number }>> {
    // One parameterized query; filter inactive accounts BEFORE the top-N limit.
    // Select only the public profile fields needed by the podium.
    const rows = await this.prisma.$queryRaw<
      Array<{ name: string; avatarUrl: string | null; coins: Prisma.Decimal }>
    >`
      SELECT u."name", u."avatarUrl", SUM(t."amount") AS coins
      FROM "wallet_transactions" t
      JOIN "wallets" w ON w."id" = t."walletId"
      JOIN "users" u ON u."id" = w."userId"
      WHERE t."type" = 'CREDIT' AND t."createdAt" >= ${since}
        AND u."isActive" = true
        AND (t."reference" IS NULL OR t."reference" NOT LIKE 'redemption-refund:%')
      GROUP BY u."id", u."name", u."avatarUrl"
      ORDER BY coins DESC, u."id" ASC LIMIT ${take}
    `;
    return rows.map((row) => ({
      user: { name: row.name, avatarUrl: row.avatarUrl },
      coins: Number(row.coins),
    }));
  }

  /** How many users this user referred + the coins credited for them. */
  async referralStats(userId: string): Promise<{ referredCount: number; coinsEarned: number }> {
    const [referredCount, credited] = await Promise.all([
      this.prisma.user.count({ where: { referredById: userId } }),
      this.prisma.walletTransaction.aggregate({
        where: {
          type: "CREDIT",
          wallet: { userId },
          reference: { startsWith: "referral:" },
        },
        _sum: { amount: true },
      }),
    ]);
    return { referredCount, coinsEarned: Number(credited._sum.amount ?? 0) };
  }

  update(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  list(params: {
    skip: number;
    take: number;
    search?: string;
    role?: Role;
  }): Promise<[User[], number]> {
    const where: Prisma.UserWhereInput = {
      ...(params.role ? { role: params.role } : {}),
      ...(params.search
        ? {
            OR: [
              { email: { contains: params.search, mode: "insensitive" } },
              { name: { contains: params.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    return Promise.all([
      this.prisma.user.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.user.count({ where }),
    ]);
  }

  count(): Promise<number> {
    return this.prisma.user.count();
  }

  /** Users who applied a referral code, newest first, with their referrer. */
  listReferrals(params: {
    skip: number;
    take: number;
    search?: string;
    from?: Date;
    to?: Date;
  }): Promise<[Array<User & { referredBy: User | null }>, number]> {
    const where: Prisma.UserWhereInput = {
      AND: [{ OR: [{ referredById: { not: null } }, { referredAt: { not: null } }] }],
      ...(params.from || params.to
        ? {
            referredAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
      ...(params.search
        ? {
            OR: [
              { email: { contains: params.search, mode: "insensitive" } },
              { referredBy: { email: { contains: params.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    return Promise.all([
      this.prisma.user.findMany({
        where,
        include: { referredBy: true },
        skip: params.skip,
        take: params.take,
        orderBy: { referredAt: "desc" },
      }),
      this.prisma.user.count({ where }),
    ]);
  }
}
