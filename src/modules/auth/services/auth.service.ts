import type { FastifyInstance } from "fastify";
import type { User } from "@prisma/client";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from "../../../common/errors.js";
import { env } from "../../../config/env.js";
import { generateOpaqueToken, hashToken, parseDuration } from "../../../utils/tokens.js";
import type { RefreshTokenRepository } from "../repositories/refresh-token.repository.js";
import type { UsersRepository } from "../../users/repositories/users.repository.js";
import type { WalletRepository } from "../../wallet/repositories/wallet.repository.js";
import { toPublicUser, type PublicUser } from "../../users/schemas/users.schema.js";
import type { AuthTokens, FirebaseAuthResult } from "../schemas/auth.schema.js";

export class AuthService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly wallets: WalletRepository,
  ) {}

  /**
   * The only sign-in path: the client authenticates with Firebase (Google
   * provider) and sends the resulting Firebase ID token; we verify it with the
   * Admin SDK and mint our own app session (JWT + rotating refresh token).
   */
  async signInWithFirebaseIdToken(idToken: string): Promise<FirebaseAuthResult> {
    if (!this.app.firebaseAuth) {
      throw new AppError(
        "Firebase authentication is not configured",
        503,
        "FIREBASE_NOT_CONFIGURED",
      );
    }

    let decoded;
    try {
      decoded = await this.app.firebaseAuth.verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedError("Invalid or expired Firebase ID token");
    }

    if (!decoded.email) {
      throw new UnauthorizedError("Firebase token is missing a verified email");
    }

    const { user, isNewUser } = await this.users.upsertFirebaseUser({
      firebaseUid: decoded.uid,
      email: decoded.email,
      name: (decoded.name as string | undefined) ?? decoded.email.split("@")[0],
      avatarUrl: decoded.picture,
    });

    if (!user.isActive) {
      throw new ForbiddenError("This account has been deactivated");
    }

    await this.wallets.ensureForUser(user.id);
    return { ...(await this.issueTokens(user)), isNewUser };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const record = await this.refreshTokens.findByHash(hashToken(refreshToken));

    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedError("Invalid or expired refresh token");
    }
    if (!record.user.isActive) {
      throw new ForbiddenError("This account has been deactivated");
    }

    // Rotation is one DB transaction. Concurrent app/web retries cannot both
    // consume the same token, and a failed replacement insert cannot strand a
    // legitimate session with its old token already revoked.
    const prepared = this.prepareTokens(record.user);
    const rotated = await this.refreshTokens.rotate(record.id, {
      userId: record.user.id,
      tokenHash: hashToken(prepared.tokens.refreshToken),
      expiresAt: prepared.expiresAt,
    });
    if (!rotated) {
      throw new UnauthorizedError("Invalid or expired refresh token");
    }
    return prepared.tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    const record = await this.refreshTokens.findByHash(hashToken(refreshToken));
    if (record && !record.revokedAt) {
      await this.refreshTokens.revoke(record.id);
    }
  }

  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllForUser(userId);
  }

  // ponytail: in-memory single-use web codes (120s TTL) — correct for a
  // single instance; codes die on restart, and the WebZone handshake already
  // retries with a fresh code. Move to Redis/DB only if replicas appear.
  private readonly webCodes = new Map<string, { userId: string; expiresAt: number }>();

  /** One-time code the app hands to the website to bootstrap a web session. */
  async createWebCode(userId: string): Promise<{ code: string }> {
    // Opportunistic sweep keeps the map from accumulating expired entries.
    const now = Date.now();
    for (const [key, entry] of this.webCodes) {
      if (entry.expiresAt <= now) this.webCodes.delete(key);
    }

    const code = generateOpaqueToken();
    this.webCodes.set(code, { userId, expiresAt: now + 120_000 });
    return { code };
  }

  /**
   * Full token pair for the embedded website, handed over by the app through
   * the WebView bridge in one call — no code round-trip, no second exchange
   * request from inside the WebView (that hop proved fragile on real phones).
   * The pair is independent of the app's own tokens, so web refresh rotation
   * can never revoke the app session.
   */
  async createWebSession(userId: string): Promise<AuthTokens> {
    const user = await this.users.findById(userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedError("Invalid session");
    }
    return this.issueTokens(user);
  }

  async exchangeWebCode(code: string): Promise<AuthTokens> {
    // Read + delete makes the code single-use (JS is single-threaded, so this
    // pair can't interleave with a concurrent exchange).
    const entry = this.webCodes.get(code);
    this.webCodes.delete(code);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new UnauthorizedError("Invalid or expired code");
    }

    const user = await this.users.findById(entry.userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedError("Invalid or expired code");
    }

    return this.issueTokens(user);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundError("User not found");
    return toPublicUser(user);
  }

  private async issueTokens(user: User): Promise<AuthTokens> {
    const prepared = this.prepareTokens(user);
    await this.refreshTokens.create(
      user.id,
      hashToken(prepared.tokens.refreshToken),
      prepared.expiresAt,
    );
    return prepared.tokens;
  }

  private prepareTokens(user: User): { tokens: AuthTokens; expiresAt: Date } {
    const accessToken = this.app.jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
    );

    const refreshToken = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + parseDuration(env.JWT_REFRESH_EXPIRES_IN));
    return {
      tokens: { accessToken, refreshToken, user: toPublicUser(user) },
      expiresAt,
    };
  }
}
