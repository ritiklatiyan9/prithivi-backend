import type { User } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { RefreshTokenRepository } from "../repositories/refresh-token.repository.js";
import type { UsersRepository } from "../../users/repositories/users.repository.js";
import type { WalletRepository } from "../../wallet/repositories/wallet.repository.js";
import { AuthService } from "./auth.service.js";

const user: User = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "user@example.com",
  name: "User",
  avatarUrl: null,
  googleId: null,
  firebaseUid: "firebase-user",
  role: "USER",
  isActive: true,
  referralCode: "REFCODE1",
  referredById: null,
  referredAt: null,
  upiId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const buildService = (rotateResult: boolean) => {
  const rotate = vi.fn(async () => rotateResult);
  const refreshTokens = {
    findByHash: vi.fn(async () => ({
      id: "old-token-id",
      tokenHash: "old-hash",
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      createdAt: new Date(),
      user,
    })),
    rotate,
  } as unknown as RefreshTokenRepository;
  const app = {
    jwt: { sign: vi.fn(() => "new-access-token") },
  } as unknown as FastifyInstance;
  const service = new AuthService(
    app,
    {} as UsersRepository,
    refreshTokens,
    {} as WalletRepository,
  );
  return { service, rotate };
};

describe("refresh-token rotation", () => {
  it("uses the repository's atomic consume-and-replace operation", async () => {
    const { service, rotate } = buildService(true);

    const tokens = await service.refresh("old-refresh-token");

    expect(tokens.accessToken).toBe("new-access-token");
    expect(tokens.refreshToken).not.toBe("old-refresh-token");
    expect(rotate).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledWith(
      "old-token-id",
      expect.objectContaining({ userId: user.id, tokenHash: expect.any(String) }),
    );
  });

  it("rejects a losing concurrent retry", async () => {
    const { service } = buildService(false);

    await expect(service.refresh("already-consumed-token")).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
  });
});
