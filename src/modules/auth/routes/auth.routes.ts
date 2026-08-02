import type { FastifyInstance } from "fastify";
import { authGuard } from "../../../middleware/auth-guard.js";
import {
  firebaseSignInSchema,
  refreshTokenSchema,
  webCodeExchangeSchema,
  type FirebaseSignInInput,
  type RefreshTokenInput,
  type WebCodeExchangeInput,
} from "../schemas/auth.schema.js";

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  const controller = app.di.authController;

  app.post<{ Body: FirebaseSignInInput }>(
    "/firebase",
    {
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Sign in with a Firebase ID token (app + admin)",
        body: firebaseSignInSchema,
      },
    },
    controller.firebaseSignIn,
  );

  app.post<{ Body: RefreshTokenInput }>(
    "/refresh",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Exchange a refresh token for new tokens (rotation)",
        body: refreshTokenSchema,
      },
    },
    controller.refresh,
  );

  app.post(
    "/web-code",
    {
      preHandler: [authGuard],
      // Generous: the WebView handshake may mint several codes per page load
      // on a slow network; the codes are cheap (in-memory, 120s TTL).
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Create a one-time code to open the website signed in (120s TTL)",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.createWebCode,
  );

  app.post(
    "/web-session",
    {
      preHandler: [authGuard],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Token pair for the embedded website, injected by the app via the WebView bridge",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.createWebSession,
  );

  app.post<{ Body: WebCodeExchangeInput }>(
    "/web-exchange",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Exchange a one-time web code for a JWT pair (single-use)",
        body: webCodeExchangeSchema,
      },
    },
    controller.exchangeWebCode,
  );

  app.post<{ Body: RefreshTokenInput }>(
    "/logout",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["auth"],
        summary: "Revoke a refresh token",
        body: refreshTokenSchema,
      },
    },
    controller.logout,
  );

  app.post(
    "/logout-all",
    {
      preHandler: [authGuard],
      schema: {
        tags: ["auth"],
        summary: "Revoke all refresh tokens for the current user",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.logoutAll,
  );

  app.get(
    "/me",
    {
      preHandler: [authGuard],
      schema: {
        tags: ["auth"],
        summary: "Get the authenticated user",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.me,
  );
};
