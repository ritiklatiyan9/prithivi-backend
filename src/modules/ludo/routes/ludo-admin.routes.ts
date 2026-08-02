import type { FastifyInstance } from "fastify";
import { authGuard } from "../../../middleware/auth-guard.js";
import { adminOnly, superAdminOnly } from "../../../middleware/role-guard.js";
import {
  adminMatchesQuerySchema,
  adminPaymentEventsQuerySchema,
  adminPlayersQuerySchema,
  adminReportsQuerySchema,
  adminRoomsQuerySchema,
  historyQuerySchema,
  resolveReportSchema,
  updateLudoConfigSchema,
  updatePlayerRestrictionsSchema,
  userIdParamsSchema,
  uuidParamsSchema,
  type AdminMatchesQuery,
  type AdminPaymentEventsQuery,
  type AdminPlayersQuery,
  type AdminReportsQuery,
  type AdminRoomsQuery,
  type LudoHistoryQuery,
  type ResolveReportInput,
  type UpdateLudoConfigInput,
  type UpdatePlayerRestrictionsInput,
  type UserIdParams,
  type UuidParams,
} from "../schemas/ludo.schema.js";

export const ludoAdminRoutes = async (app: FastifyInstance): Promise<void> => {
  const controller = app.di.ludoAdminController;
  const read = { preHandler: [authGuard, adminOnly], schema: { tags: ["ludo-admin"], security: [{ bearerAuth: [] }] } };
  const write = { preHandler: [authGuard, superAdminOnly], schema: { tags: ["ludo-admin"], security: [{ bearerAuth: [] }] } };

  app.get("/overview", { ...read, schema: { ...read.schema, summary: "Ludo operations overview" } }, controller.overview);
  app.get("/config", { ...read, schema: { ...read.schema, summary: "Ludo feature flags and rules" } }, controller.config);
  app.patch<{ Body: UpdateLudoConfigInput }>("/config", { ...write, schema: { ...write.schema, summary: "Update validated Ludo config", body: updateLudoConfigSchema } }, controller.updateConfig);
  app.get<{ Querystring: AdminRoomsQuery }>("/rooms", { ...read, schema: { ...read.schema, summary: "Live/pregame rooms", querystring: adminRoomsQuerySchema } }, controller.rooms);
  app.get<{ Params: UuidParams }>("/rooms/:id", { ...read, schema: { ...read.schema, summary: "Room state and event audit", params: uuidParamsSchema } }, controller.room);
  app.get<{ Querystring: AdminMatchesQuery }>("/matches", { ...read, schema: { ...read.schema, summary: "Completed/cancelled matches", querystring: adminMatchesQuerySchema } }, controller.matches);
  app.get<{ Params: UuidParams }>("/matches/:id", { ...read, schema: { ...read.schema, summary: "Match state and event audit", params: uuidParamsSchema } }, controller.room);
  app.get<{ Querystring: AdminPlayersQuery }>("/players", { ...read, schema: { ...read.schema, summary: "Ludo players", querystring: adminPlayersQuerySchema } }, controller.players);
  app.get<{ Params: UserIdParams }>("/players/:userId", { ...read, schema: { ...read.schema, summary: "Ludo player details", params: userIdParamsSchema } }, controller.player);
  app.patch<{ Params: UserIdParams; Body: UpdatePlayerRestrictionsInput }>("/players/:userId/restrictions", { ...write, schema: { ...write.schema, summary: "Suspend game or mute communication", params: userIdParamsSchema, body: updatePlayerRestrictionsSchema } }, controller.restrictions);
  app.get<{ Querystring: AdminReportsQuery }>("/reports", { ...read, schema: { ...read.schema, summary: "Player reports", querystring: adminReportsQuerySchema } }, controller.reports);
  app.patch<{ Params: UuidParams; Body: ResolveReportInput }>("/reports/:id/resolve", { ...write, schema: { ...write.schema, summary: "Resolve or dismiss report", params: uuidParamsSchema, body: resolveReportSchema } }, controller.resolveReport);
  app.get("/subscriptions/analytics", { ...read, schema: { ...read.schema, summary: "Subscription analytics" } }, controller.subscriptionAnalytics);
  app.get<{ Querystring: AdminPaymentEventsQuery }>("/payment-events", { ...read, schema: { ...read.schema, summary: "Webhook payment audit", querystring: adminPaymentEventsQuerySchema } }, controller.paymentEvents);
  app.get("/monitoring", { ...read, schema: { ...read.schema, summary: "Realtime health and queue metrics" } }, controller.monitoring);
  app.get<{ Querystring: LudoHistoryQuery }>("/audit-logs", { ...read, schema: { ...read.schema, summary: "Ludo admin mutation audit", querystring: historyQuerySchema } }, controller.auditLogs);
};
