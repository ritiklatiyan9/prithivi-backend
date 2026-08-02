import type { PrismaClient, RefreshToken, User } from "@prisma/client";

export type RefreshTokenWithUser = RefreshToken & { user: User };

export class RefreshTokenRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(userId: string, tokenHash: string, expiresAt: Date): Promise<RefreshToken> {
    return this.prisma.refreshToken.create({ data: { userId, tokenHash, expiresAt } });
  }

  findByHash(tokenHash: string): Promise<RefreshTokenWithUser | null> {
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
  }

  revoke(id: string): Promise<RefreshToken> {
    return this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Atomically consumes one live refresh token and creates its replacement.
   * The guarded update makes concurrent refresh retries deterministic: only
   * one request can rotate a token, and a failed replacement insert rolls the
   * revocation back with the surrounding transaction.
   */
  rotate(
    id: string,
    replacement: { userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const consumed = await tx.refreshToken.updateMany({
        where: { id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() },
      });
      if (consumed.count === 0) return false;
      await tx.refreshToken.create({ data: replacement });
      return true;
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async deleteExpired(): Promise<number> {
    const result = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }
}
