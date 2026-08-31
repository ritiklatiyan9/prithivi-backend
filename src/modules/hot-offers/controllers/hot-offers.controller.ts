import type { FastifyReply, FastifyRequest } from "fastify";
import { success } from "../../../common/response.js";
import type { HotOffersService } from "../services/hot-offers.service.js";
import type {
  AdminListOffersQuery,
  AnalyticsQuery,
  IdParams,
  ListOffersQuery,
  SlugParams,
  TrackEventInput,
  UpsertCategoryInput,
  UpsertFeedbackPageInput,
  UpsertOfferInput,
} from "../schemas/hot-offers.schema.js";
import type {
  ListSubmissionsQuery,
  ReviewSubmissionInput,
  SubmitProofInput,
} from "../schemas/submissions.schema.js";

export class HotOffersController {
  constructor(private readonly service: HotOffersService) {}

  private cachePublic(reply: FastifyReply): FastifyReply {
    // CDN/browser cache is intentionally shorter than the server cache's
    // worst-case staleness across multiple API replicas.
    return reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
  }

  // ---- public ----

  listCategories = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    this.cachePublic(reply).send(success(await this.service.listPublicCategories()));
  };

  getFeedbackPage = async (
    request: FastifyRequest<{ Params: SlugParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    this.cachePublic(reply).send(
      success(await this.service.getPublicFeedbackPage(request.params.slug)),
    );
  };

  listOffers = async (
    request: FastifyRequest<{ Querystring: ListOffersQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const userId = request.user?.sub;
    const { items, meta } = await this.service.listPublicOffers(request.query, userId);
    // Personalized responses must never land in a shared CDN/proxy cache.
    (userId ? reply.header("Cache-Control", "private, no-store") : this.cachePublic(reply)).send(
      success(items, meta),
    );
  };

  getOffer = async (
    request: FastifyRequest<{ Params: SlugParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const userId = request.user?.sub;
    const offer = await this.service.getPublicOffer(request.params.slug, userId);
    (userId ? reply.header("Cache-Control", "private, no-store") : this.cachePublic(reply)).send(
      success(offer),
    );
  };

  getOfferComment = async (
    request: FastifyRequest<{ Params: SlugParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.getOfferReviewComment(request.params.slug)));
  };

  trackEvent = async (
    request: FastifyRequest<{ Body: TrackEventInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    // optionalAuth ran before this: request.user is set only for signed-in callers.
    await this.service.trackEvent(request.body, request.user?.sub);
    reply.status(202).send(success({ tracked: true }));
  };

  // ---- admin ----

  adminListCategories = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.adminListCategories()));
  };

  createCategory = async (
    request: FastifyRequest<{ Body: UpsertCategoryInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.status(201).send(success(await this.service.createCategory(request.body)));
  };

  updateCategory = async (
    request: FastifyRequest<{ Params: IdParams; Body: UpsertCategoryInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.updateCategory(request.params.id, request.body)));
  };

  deleteCategory = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    await this.service.deleteCategory(request.params.id);
    reply.send(success({ deleted: true }));
  };

  adminGetFeedbackPage = async (
    request: FastifyRequest<{ Params: SlugParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.adminGetFeedbackPage(request.params.slug)));
  };

  upsertFeedbackPage = async (
    request: FastifyRequest<{ Params: IdParams; Body: UpsertFeedbackPageInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.upsertFeedbackPage(request.params.id, request.body)));
  };

  adminListOffers = async (
    request: FastifyRequest<{ Querystring: AdminListOffersQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { items, meta } = await this.service.adminListOffers(request.query);
    reply.send(success(items, meta));
  };

  adminGetOffer = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.adminGetOffer(request.params.id)));
  };

  createOffer = async (
    request: FastifyRequest<{ Body: UpsertOfferInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.status(201).send(success(await this.service.createOffer(request.body)));
  };

  updateOffer = async (
    request: FastifyRequest<{ Params: IdParams; Body: UpsertOfferInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.updateOffer(request.params.id, request.body)));
  };

  deleteOffer = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    await this.service.deleteOffer(request.params.id);
    reply.send(success({ deleted: true }));
  };

  analytics = async (
    request: FastifyRequest<{ Querystring: AnalyticsQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.analytics(request.query)));
  };

  fraudOverview = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.fraudOverview()));
  };

  // ---- proof submissions ----

  submitProof = async (
    request: FastifyRequest<{ Body: SubmitProofInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.status(201).send(success(await this.service.submitProof(request.user.sub, request.body)));
  };

  listMySubmissions = async (
    request: FastifyRequest<{ Querystring: ListSubmissionsQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { items, meta } = await this.service.listMySubmissions(request.user.sub, request.query);
    reply.send(success(items, meta));
  };

  adminListSubmissions = async (
    request: FastifyRequest<{ Querystring: ListSubmissionsQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { items, meta } = await this.service.adminListSubmissions(request.query);
    reply.send(success(items, meta));
  };

  reviewSubmission = async (
    request: FastifyRequest<{ Params: IdParams; Body: ReviewSubmissionInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(
      success(
        await this.service.reviewSubmission(request.params.id, request.user.sub, request.body),
      ),
    );
  };

  reopenSubmission = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.reopenSubmission(request.params.id, request.user.sub)));
  };

  mySubmissionForOffer = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(
      success(await this.service.getMySubmissionForOffer(request.user.sub, request.params.id)),
    );
  };

  cancelSubmission = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.cancelSubmission(request.user.sub, request.params.id)));
  };
}
