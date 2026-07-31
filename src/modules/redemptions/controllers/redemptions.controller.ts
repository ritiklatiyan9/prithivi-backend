import type { FastifyReply, FastifyRequest } from "fastify";
import { success } from "../../../common/response.js";
import type { RedemptionsService } from "../services/redemptions.service.js";
import type {
  AdminListRedemptionsQuery,
  CreateRedemptionInput,
  CreateVoucherOfferInput,
  FulfillRedemptionInput,
  IdParams,
  ListMineQuery,
  MarkPaidInput,
  ReviewRedemptionInput,
  UpdateVoucherOfferInput,
} from "../schemas/redemptions.schema.js";

export class RedemptionsController {
  constructor(private readonly service: RedemptionsService) {}

  config = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.getConfig()));
  };

  request = async (
    request: FastifyRequest<{ Body: CreateRedemptionInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const redemption = await this.service.request(request.user.sub, request.body);
    reply.status(201).send(success(redemption));
  };

  listMine = async (
    request: FastifyRequest<{ Querystring: ListMineQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { items, meta } = await this.service.listMine(request.user.sub, request.query);
    reply.send(success(items, meta));
  };

  catalog = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.listCatalog()));
  };

  catalogAdmin = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.listCatalogAdmin()));
  };

  createOffer = async (
    request: FastifyRequest<{ Body: CreateVoucherOfferInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.status(201).send(success(await this.service.createOffer(request.body)));
  };

  updateOffer = async (
    request: FastifyRequest<{ Params: IdParams; Body: UpdateVoucherOfferInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.updateOffer(request.params.id, request.body)));
  };

  deleteOffer = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    await this.service.deleteOffer(request.params.id);
    reply.status(204).send();
  };

  listAdmin = async (
    request: FastifyRequest<{ Querystring: AdminListRedemptionsQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { items, meta } = await this.service.listAdmin(request.query);
    reply.send(success(items, meta));
  };

  review = async (
    request: FastifyRequest<{ Params: IdParams; Body: ReviewRedemptionInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const redemption = await this.service.review(
      request.params.id,
      request.user.sub,
      request.body,
    );
    reply.send(success(redemption));
  };

  claim = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.claim(request.params.id, request.user.sub)));
  };

  release = async (
    request: FastifyRequest<{ Params: IdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.release(request.params.id)));
  };

  markPaid = async (
    request: FastifyRequest<{ Params: IdParams; Body: MarkPaidInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const redemption = await this.service.markPaid(
      request.params.id,
      request.user.sub,
      request.body,
    );
    reply.send(success(redemption));
  };

  fulfill = async (
    request: FastifyRequest<{ Params: IdParams; Body: FulfillRedemptionInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const redemption = await this.service.fulfill(
      request.params.id,
      request.user.sub,
      request.body,
    );
    reply.send(success(redemption));
  };

  providerStatus = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.providerStatus()));
  };

  providerTest = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.testProvider()));
  };
}
