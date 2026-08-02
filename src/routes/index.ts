import type { FastifyInstance } from "fastify";
import { authRoutes } from "../modules/auth/routes/auth.routes.js";
import { usersRoutes } from "../modules/users/routes/users.routes.js";
import { campaignRoutes } from "../modules/campaign/routes/campaign.routes.js";
import { claimsRoutes } from "../modules/claims/routes/claims.routes.js";
import { walletRoutes } from "../modules/wallet/routes/wallet.routes.js";
import { notificationsRoutes } from "../modules/notifications/routes/notifications.routes.js";
import { analyticsRoutes } from "../modules/analytics/routes/analytics.routes.js";
import { adminRoutes } from "../modules/admin/routes/admin.routes.js";
import { uploadsRoutes } from "../modules/uploads/routes/uploads.routes.js";
import { hotOffersRoutes } from "../modules/hot-offers/routes/hot-offers.routes.js";
import { settingsRoutes, publicConfigRoutes } from "../modules/settings/routes/settings.routes.js";
import { redemptionsRoutes } from "../modules/redemptions/routes/redemptions.routes.js";
import { appAssetsRoutes } from "../modules/app-assets/routes/app-assets.routes.js";
import { missionsRoutes } from "../modules/missions/routes/missions.routes.js";
import { gameRoutes } from "../modules/game/routes/game.routes.js";
import { rouletteRoutes } from "../modules/roulette/routes/roulette.routes.js";
import { coinPurchaseRoutes } from "../modules/payments/routes/coin-purchase.routes.js";
import { ludoRoutes } from "../modules/ludo/routes/ludo.routes.js";
import { ludoAdminRoutes } from "../modules/ludo/routes/ludo-admin.routes.js";
import { env } from "../config/env.js";

export const registerRoutes = async (app: FastifyInstance): Promise<void> => {
  await app.register(
    async (api) => {
      api.get("/health", { schema: { tags: ["admin"], summary: "Liveness probe" } }, async () => ({
        status: "ok",
        uptime: process.uptime(),
      }));

      api.get(
        "/health/ready",
        { schema: { tags: ["admin"], summary: "Readiness probe (DB)" } },
        async (_request, reply) => {
          try {
            await api.prisma.$queryRaw`SELECT 1`;
            return { status: "ready" };
          } catch (error) {
            api.log.error(error, "readiness check failed");
            return reply.status(503).send({ status: "unavailable" });
          }
        },
      );

      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(usersRoutes, { prefix: "/users" });
      await api.register(campaignRoutes, { prefix: "/campaigns" });
      await api.register(claimsRoutes, { prefix: "/claims" });
      await api.register(walletRoutes, { prefix: "/wallet" });
      await api.register(notificationsRoutes, { prefix: "/notifications" });
      await api.register(analyticsRoutes, { prefix: "/analytics" });
      await api.register(adminRoutes, { prefix: "/admin" });
      await api.register(uploadsRoutes, { prefix: "/uploads" });
      await api.register(hotOffersRoutes, { prefix: "/hot-offers" });
      await api.register(settingsRoutes, { prefix: "/settings" });
      await api.register(publicConfigRoutes);
      await api.register(redemptionsRoutes, { prefix: "/redemptions" });
      await api.register(appAssetsRoutes, { prefix: "/app-assets" });
      await api.register(missionsRoutes, { prefix: "/missions" });
      await api.register(gameRoutes, { prefix: "/game" });
      await api.register(rouletteRoutes, { prefix: "/game" });
      await api.register(coinPurchaseRoutes, { prefix: "/wallet/coin-purchases" });
      await api.register(ludoRoutes, { prefix: "/ludo" });
      await api.register(ludoAdminRoutes, { prefix: "/admin/game" });
    },
    { prefix: env.API_PREFIX },
  );
};
