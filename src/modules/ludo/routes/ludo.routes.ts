import type { FastifyInstance } from "fastify";
import { authGuard } from "../../../middleware/auth-guard.js";
import {
  createSubscriptionOrderSchema,
  historyQuerySchema,
  restPlayerBlockSchema,
  restPlayerReportSchema,
  userIdParamsSchema,
  type CreateSubscriptionOrderInput,
  type LudoHistoryQuery,
  type RestPlayerBlockInput,
  type RestPlayerReportInput,
  type UserIdParams,
  type VerifySubscriptionInput,
  verifySubscriptionSchema,
} from "../schemas/ludo.schema.js";
import { registerLudoSocketGateway } from "../sockets/ludo-gateway.js";

export const ludoRoutes = async (app: FastifyInstance): Promise<void> => {
  registerLudoSocketGateway(app);
  const controller = app.di.ludoController;
  const authenticated = {
    preHandler: [authGuard],
    schema: { tags: ["ludo"], security: [{ bearerAuth: [] }] },
  };

  app.get(
    "/config",
    {
      ...authenticated,
      schema: { ...authenticated.schema, summary: "Ludo runtime config and entitlement" },
    },
    controller.config,
  );
  app.get(
    "/active",
    {
      ...authenticated,
      schema: { ...authenticated.schema, summary: "Resume-safe active Ludo snapshot" },
    },
    controller.active,
  );
  app.get<{ Querystring: LudoHistoryQuery }>(
    "/history",
    {
      ...authenticated,
      schema: {
        ...authenticated.schema,
        summary: "Ludo match history",
        querystring: historyQuerySchema,
      },
    },
    controller.history,
  );
  app.get(
    "/statistics",
    { ...authenticated, schema: { ...authenticated.schema, summary: "Ludo lifetime statistics" } },
    controller.statistics,
  );
  app.post<{ Body: RestPlayerReportInput }>(
    "/reports",
    {
      ...authenticated,
      schema: {
        ...authenticated.schema,
        summary: "Report a player or message",
        body: restPlayerReportSchema,
      },
    },
    controller.report,
  );
  app.post<{ Body: RestPlayerBlockInput }>(
    "/blocks",
    {
      ...authenticated,
      schema: { ...authenticated.schema, summary: "Block a player", body: restPlayerBlockSchema },
    },
    controller.block,
  );
  app.delete<{ Params: UserIdParams }>(
    "/blocks/:userId",
    {
      ...authenticated,
      schema: { ...authenticated.schema, summary: "Unblock a player", params: userIdParamsSchema },
    },
    controller.unblock,
  );

  app.get(
    "/subscriptions/plans",
    { ...authenticated, schema: { ...authenticated.schema, summary: "Ludo subscription plans" } },
    controller.plans,
  );
  app.get(
    "/subscriptions/current",
    {
      ...authenticated,
      schema: { ...authenticated.schema, summary: "Current Ludo subscription and entitlement" },
    },
    controller.currentSubscription,
  );
  app.get(
    "/subscriptions/history",
    { ...authenticated, schema: { ...authenticated.schema, summary: "Ludo subscription history" } },
    controller.subscriptionHistory,
  );
  app.post<{ Body: CreateSubscriptionOrderInput }>(
    "/subscriptions/orders",
    {
      ...authenticated,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      schema: {
        ...authenticated.schema,
        summary: "Create Razorpay Ludo membership checkout",
        body: createSubscriptionOrderSchema,
      },
    },
    controller.createSubscriptionOrder,
  );
  app.post<{ Body: VerifySubscriptionInput }>(
    "/subscriptions/verify",
    {
      ...authenticated,
      config: { rateLimit: { max: 12, timeWindow: "1 minute" } },
      schema: {
        ...authenticated.schema,
        summary: "Authenticate a Razorpay checkout",
        body: verifySubscriptionSchema,
      },
    },
    controller.verifySubscription,
  );
  app.post(
    "/subscriptions/restore",
    {
      ...authenticated,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      schema: { ...authenticated.schema, summary: "Reconcile current Ludo subscription" },
    },
    controller.restoreSubscription,
  );
  app.post(
    "/subscriptions/cancel",
    {
      ...authenticated,
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
      schema: { ...authenticated.schema, summary: "Cancel Ludo subscription at period end" },
    },
    controller.cancelSubscription,
  );

  app.post(
    "/subscriptions/webhook",
    {
      config: { rawBody: true, rateLimit: { max: 300, timeWindow: "1 minute" } },
      schema: {
        tags: ["ludo-payments"],
        summary: "Signed Razorpay subscription webhook",
        hide: true,
      },
    },
    controller.webhook,
  );
};
