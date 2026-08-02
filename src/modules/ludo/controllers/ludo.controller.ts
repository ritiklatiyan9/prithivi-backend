import type { FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError } from "../../../common/errors.js";
import { success } from "../../../common/response.js";
import type {
  CreateSubscriptionOrderInput,
  LudoHistoryQuery,
  RestPlayerBlockInput,
  RestPlayerReportInput,
  UserIdParams,
  VerifySubscriptionInput,
} from "../schemas/ludo.schema.js";
import type { LudoService } from "../services/ludo.service.js";
import type { LudoSubscriptionService } from "../services/ludo-subscription.service.js";

export class LudoController {
  constructor(
    private readonly ludo: LudoService,
    private readonly subscriptions: LudoSubscriptionService,
  ) {}

  config = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.ludo.getConfig(request.user.sub)));
  };

  active = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.ludo.getActive(request.user.sub)));
  };

  history = async (
    request: FastifyRequest<{ Querystring: LudoHistoryQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.ludo.getHistory(request.user.sub, request.query);
    reply.send(success(result.items, result.meta));
  };

  statistics = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.ludo.getStatistics(request.user.sub)));
  };

  report = async (
    request: FastifyRequest<{ Body: RestPlayerReportInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const { gameId, ...input } = request.body;
    reply.status(201).send(success(await this.ludo.reportPlayer(request.user.sub, gameId, input)));
  };

  block = async (
    request: FastifyRequest<{ Body: RestPlayerBlockInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    await this.ludo.setBlock(request.user.sub, request.body.userId, true);
    reply.send(success({ userId: request.body.userId, blocked: true }));
  };

  unblock = async (
    request: FastifyRequest<{ Params: UserIdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    await this.ludo.setBlock(request.user.sub, request.params.userId, false);
    reply.send(success({ userId: request.params.userId, blocked: false }));
  };

  plans = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.subscriptions.plans()));
  };

  currentSubscription = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.subscriptions.current(request.user.sub)));
  };

  subscriptionHistory = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.subscriptions.history(request.user.sub)));
  };

  createSubscriptionOrder = async (
    request: FastifyRequest<{ Body: CreateSubscriptionOrderInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.status(201).send(success(await this.subscriptions.createOrder(request.user.sub, request.body)));
  };

  verifySubscription = async (
    request: FastifyRequest<{ Body: VerifySubscriptionInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.subscriptions.verify(request.user.sub, request.body)));
  };

  restoreSubscription = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.subscriptions.restore(request.user.sub)));
  };

  cancelSubscription = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.subscriptions.cancel(request.user.sub)));
  };

  webhook = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) throw new BadRequestError("Raw webhook body is unavailable");
    const signature = request.headers["x-razorpay-signature"];
    const eventId = request.headers["x-razorpay-event-id"];
    reply.send(
      success(
        await this.subscriptions.webhook(
          rawBody,
          Array.isArray(signature) ? signature[0] : signature,
          Array.isArray(eventId) ? eventId[0] : eventId,
        ),
      ),
    );
  };
}
