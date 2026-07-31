import type { FastifyInstance } from "fastify";
import { authGuard } from "../../../middleware/auth-guard.js";
import { adminOnly, superAdminOnly } from "../../../middleware/role-guard.js";
import {
  adminListRedemptionsQuerySchema,
  createRedemptionSchema,
  createVoucherOfferSchema,
  fulfillRedemptionSchema,
  idParamsSchema,
  listMineQuerySchema,
  markPaidSchema,
  reviewRedemptionSchema,
  updateVoucherOfferSchema,
  type AdminListRedemptionsQuery,
  type CreateRedemptionInput,
  type CreateVoucherOfferInput,
  type FulfillRedemptionInput,
  type IdParams,
  type ListMineQuery,
  type MarkPaidInput,
  type ReviewRedemptionInput,
  type UpdateVoucherOfferInput,
} from "../schemas/redemptions.schema.js";

/** Registered under /redemptions. User endpoints need auth; admin list is
 *  ADMIN read, review/fulfill are SUPER_ADMIN write. */
export const redemptionsRoutes = async (app: FastifyInstance): Promise<void> => {
  const controller = app.di.redemptionsController;

  app.get(
    "/config",
    {
      schema: {
        tags: ["redemptions"],
        summary: "Redemption config: enabled flag + minimum coins",
      },
    },
    controller.config,
  );

  app.post<{ Body: CreateRedemptionInput }>(
    "/",
    {
      preHandler: [authGuard],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["redemptions"],
        summary: "Request a coin redemption (debits wallet, awaits admin review)",
        security: [{ bearerAuth: [] }],
        body: createRedemptionSchema,
      },
    },
    controller.request,
  );

  app.get<{ Querystring: ListMineQuery }>(
    "/me",
    {
      preHandler: [authGuard],
      schema: {
        tags: ["redemptions"],
        summary: "List my redemption requests, newest first (optional status filter)",
        security: [{ bearerAuth: [] }],
        querystring: listMineQuerySchema,
      },
    },
    controller.listMine,
  );

  app.get(
    "/catalog",
    {
      schema: {
        tags: ["redemptions"],
        summary: "Active voucher catalog (the app's coupon store)",
      },
    },
    controller.catalog,
  );

  // ---- admin ----

  app.get<{ Querystring: AdminListRedemptionsQuery }>(
    "/",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["redemptions"],
        summary: "All redemptions with status/user/email/date filters (admin)",
        security: [{ bearerAuth: [] }],
        querystring: adminListRedemptionsQuerySchema,
      },
    },
    controller.listAdmin,
  );

  app.patch<{ Params: IdParams; Body: ReviewRedemptionInput }>(
    "/:id/review",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["redemptions"],
        summary:
          "Approve (issues voucher via provider, or queues manual) or reject (refunds coins) a redemption (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: reviewRedemptionSchema,
      },
    },
    controller.review,
  );

  app.patch<{ Params: IdParams }>(
    "/:id/claim",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["redemptions"],
        summary:
          "Claim a UPI payout before sending the money — blocks reject/refund until paid or released (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.claim,
  );

  app.patch<{ Params: IdParams }>(
    "/:id/release",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["redemptions"],
        summary: "Release a claimed-but-unpaid UPI payout back to the pending queue (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.release,
  );

  app.patch<{ Params: IdParams; Body: MarkPaidInput }>(
    "/:id/mark-paid",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["redemptions"],
        summary:
          "Confirm a UPI payout request was paid to the user's UPI ID; optional UTR reference (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: markPaidSchema,
      },
    },
    controller.markPaid,
  );

  app.patch<{ Params: IdParams; Body: FulfillRedemptionInput }>(
    "/:id/fulfill",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["redemptions"],
        summary: "Manually attach a voucher to an approved redemption (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: fulfillRedemptionSchema,
      },
    },
    controller.fulfill,
  );

  // ---- reward provider (Xoxoday) admin ----

  app.get(
    "/admin/provider/status",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["redemptions"],
        summary: "Xoxoday reward-provider configuration status (no secrets) (admin)",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.providerStatus,
  );

  app.post(
    "/admin/provider/test",
    {
      preHandler: [authGuard, superAdminOnly],
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["redemptions"],
        summary: "Test the configured Xoxoday credentials (super admin)",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.providerTest,
  );

  // ---- voucher catalog admin ----

  app.get(
    "/admin/catalog",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["redemptions"],
        summary: "Full voucher catalog including inactive offers (admin)",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.catalogAdmin,
  );

  app.post<{ Body: CreateVoucherOfferInput }>(
    "/admin/catalog",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["redemptions"],
        summary: "Create a voucher offer (super admin)",
        security: [{ bearerAuth: [] }],
        body: createVoucherOfferSchema,
      },
    },
    controller.createOffer,
  );

  app.patch<{ Params: IdParams; Body: UpdateVoucherOfferInput }>(
    "/admin/catalog/:id",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["redemptions"],
        summary: "Update a voucher offer (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: updateVoucherOfferSchema,
      },
    },
    controller.updateOffer,
  );

  app.delete<{ Params: IdParams }>(
    "/admin/catalog/:id",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["redemptions"],
        summary:
          "Delete a voucher offer; 409 when redemptions reference it — PATCH isActive:false instead (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.deleteOffer,
  );
};
