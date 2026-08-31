import type { FastifyInstance } from "fastify";
import { authGuard, optionalAuth } from "../../../middleware/auth-guard.js";
import { adminOnly, superAdminOnly } from "../../../middleware/role-guard.js";
import {
  adminListOffersQuerySchema,
  analyticsQuerySchema,
  idParamsSchema,
  listOffersQuerySchema,
  slugParamsSchema,
  trackEventSchema,
  upsertCategorySchema,
  upsertFeedbackPageSchema,
  upsertOfferSchema,
  type AdminListOffersQuery,
  type AnalyticsQuery,
  type IdParams,
  type ListOffersQuery,
  type SlugParams,
  type TrackEventInput,
  type UpsertCategoryInput,
  type UpsertFeedbackPageInput,
  type UpsertOfferInput,
} from "../schemas/hot-offers.schema.js";
import {
  listSubmissionsQuerySchema,
  reviewSubmissionSchema,
  submitProofSchema,
  type ListSubmissionsQuery,
  type ReviewSubmissionInput,
  type SubmitProofInput,
} from "../schemas/submissions.schema.js";

/**
 * Registered under /hot-offers.
 * Public endpoints serve the app and the anonymous website (published content
 * only); /admin/* endpoints are ADMIN read / SUPER_ADMIN write.
 */
export const hotOffersRoutes = async (app: FastifyInstance): Promise<void> => {
  const controller = app.di.hotOffersController;

  // ---- public ----

  app.get(
    "/categories",
    {
      schema: {
        tags: ["hot-offers"],
        summary: "Published offer categories, ordered for the app's Hot Offers screen",
      },
    },
    controller.listCategories,
  );

  app.get<{ Params: SlugParams }>(
    "/categories/:slug/feedback-page",
    {
      schema: {
        tags: ["hot-offers"],
        summary: "Published feedback page for a category",
        params: slugParamsSchema,
      },
    },
    controller.getFeedbackPage,
  );

  app.get<{ Querystring: ListOffersQuery }>(
    "/offers",
    {
      // optionalAuth: signed-in callers get a personalized list (their
      // completed offers hidden/flagged per the admin's completedBehavior).
      preHandler: [optionalAuth],
      schema: {
        tags: ["hot-offers"],
        summary: "Published offers with search, category filter, sorting and pagination",
        querystring: listOffersQuerySchema,
      },
    },
    controller.listOffers,
  );

  app.get<{ Params: SlugParams }>(
    "/offers/:slug",
    {
      preHandler: [optionalAuth],
      schema: {
        tags: ["hot-offers"],
        summary: "Published offer details",
        params: slugParamsSchema,
      },
    },
    controller.getOffer,
  );

  app.get<{ Params: SlugParams }>(
    "/offers/:slug/comment",
    {
      schema: {
        tags: ["hot-offers"],
        summary: "Newly generated suggested review comment for a published offer",
        params: slugParamsSchema,
      },
    },
    controller.getOfferComment,
  );

  app.post<{ Body: TrackEventInput }>(
    "/events",
    {
      // Anonymous by design (website visitors); optionalAuth attaches userId
      // for signed-in app users. Tight limit — it is an unauthenticated write.
      preHandler: [optionalAuth],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["hot-offers"],
        summary: "Track a view/click/download event",
        body: trackEventSchema,
      },
    },
    controller.trackEvent,
  );

  // ---- proof submissions (authenticated user) ----

  app.post<{ Body: SubmitProofInput }>(
    "/submissions",
    {
      preHandler: [authGuard],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["hot-offers"],
        summary: "Submit a proof screenshot for an offer (auth)",
        security: [{ bearerAuth: [] }],
        body: submitProofSchema,
      },
    },
    controller.submitProof,
  );

  app.get<{ Querystring: ListSubmissionsQuery }>(
    "/submissions/mine",
    {
      preHandler: [authGuard],
      schema: {
        tags: ["hot-offers"],
        summary: "List my proof submissions and their review status",
        security: [{ bearerAuth: [] }],
        querystring: listSubmissionsQuerySchema,
      },
    },
    controller.listMySubmissions,
  );

  app.get<{ Params: IdParams }>(
    "/offers/:id/my-submission",
    {
      preHandler: [authGuard],
      schema: {
        tags: ["hot-offers"],
        summary: "My submission (if any) for a specific offer",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.mySubmissionForOffer,
  );

  app.post<{ Params: IdParams }>(
    "/submissions/:id/cancel",
    {
      preHandler: [authGuard],
      schema: {
        tags: ["hot-offers"],
        summary: "Cancel my own pending submission",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.cancelSubmission,
  );

  // ---- admin ----

  app.get<{ Querystring: ListSubmissionsQuery }>(
    "/admin/submissions",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "All proof submissions with screenshots for review (admin)",
        security: [{ bearerAuth: [] }],
        querystring: listSubmissionsQuerySchema,
      },
    },
    controller.adminListSubmissions,
  );

  app.patch<{ Params: IdParams; Body: ReviewSubmissionInput }>(
    "/admin/submissions/:id/review",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Approve (credits wallet) or reject a proof submission (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: reviewSubmissionSchema,
      },
    },
    controller.reviewSubmission,
  );

  app.patch<{ Params: IdParams }>(
    "/admin/submissions/:id/reopen",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary:
          "Let the user participate in this offer again (finished submission -> CANCELLED; credited coins untouched) (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.reopenSubmission,
  );

  app.get(
    "/admin/categories",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "All categories including drafts (admin)",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.adminListCategories,
  );

  app.post<{ Body: UpsertCategoryInput }>(
    "/admin/categories",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Create a category (super admin)",
        security: [{ bearerAuth: [] }],
        body: upsertCategorySchema,
      },
    },
    controller.createCategory,
  );

  app.put<{ Params: IdParams; Body: UpsertCategoryInput }>(
    "/admin/categories/:id",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Update a category (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: upsertCategorySchema,
      },
    },
    controller.updateCategory,
  );

  app.delete<{ Params: IdParams }>(
    "/admin/categories/:id",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Soft-delete a category (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.deleteCategory,
  );

  app.get<{ Params: SlugParams }>(
    "/admin/categories/:slug/feedback-page",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Feedback page for a category, any status (admin)",
        security: [{ bearerAuth: [] }],
        params: slugParamsSchema,
      },
    },
    controller.adminGetFeedbackPage,
  );

  app.put<{ Params: IdParams; Body: UpsertFeedbackPageInput }>(
    "/admin/categories/:id/feedback-page",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Create or update a category's feedback page (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: upsertFeedbackPageSchema,
      },
    },
    controller.upsertFeedbackPage,
  );

  app.get<{ Querystring: AdminListOffersQuery }>(
    "/admin/offers",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "All offers with status filter (admin)",
        security: [{ bearerAuth: [] }],
        querystring: adminListOffersQuerySchema,
      },
    },
    controller.adminListOffers,
  );

  app.get<{ Params: IdParams }>(
    "/admin/offers/:id",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Offer details, any status (admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.adminGetOffer,
  );

  app.post<{ Body: UpsertOfferInput }>(
    "/admin/offers",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Create an offer (super admin)",
        security: [{ bearerAuth: [] }],
        body: upsertOfferSchema,
      },
    },
    controller.createOffer,
  );

  app.put<{ Params: IdParams; Body: UpsertOfferInput }>(
    "/admin/offers/:id",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Update an offer (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: upsertOfferSchema,
      },
    },
    controller.updateOffer,
  );

  app.delete<{ Params: IdParams }>(
    "/admin/offers/:id",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Soft-delete an offer (super admin)",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
      },
    },
    controller.deleteOffer,
  );

  app.get<{ Querystring: AnalyticsQuery }>(
    "/admin/analytics",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Views, clicks, downloads, CTR, conversion, top offers/categories",
        security: [{ bearerAuth: [] }],
        querystring: analyticsQuerySchema,
      },
    },
    controller.analytics,
  );

  app.get(
    "/admin/fraud",
    {
      preHandler: [authGuard, adminOnly],
      schema: {
        tags: ["hot-offers"],
        summary: "Fraud overview: flagged users (by score) and recent fraud events",
        security: [{ bearerAuth: [] }],
      },
    },
    controller.fraudOverview,
  );
};
