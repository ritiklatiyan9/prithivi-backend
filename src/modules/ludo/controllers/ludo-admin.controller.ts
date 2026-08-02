import type { FastifyReply, FastifyRequest } from "fastify";
import { success } from "../../../common/response.js";
import type {
  AdminMatchesQuery,
  AdminPaymentEventsQuery,
  AdminPlayersQuery,
  AdminReportsQuery,
  AdminRoomsQuery,
  LudoHistoryQuery,
  ResolveReportInput,
  UpdateLudoConfigInput,
  UpdatePlayerRestrictionsInput,
  UserIdParams,
  UuidParams,
} from "../schemas/ludo.schema.js";
import type { LudoAdminService } from "../services/ludo-admin.service.js";

export class LudoAdminController {
  constructor(private readonly service: LudoAdminService) {}

  overview = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.overview()));
  };
  config = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.config()));
  };
  updateConfig = async (
    request: FastifyRequest<{ Body: UpdateLudoConfigInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.updateConfig(request.body, request.user.sub)));
  };
  rooms = async (
    request: FastifyRequest<{ Querystring: AdminRoomsQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.service.rooms(request.query);
    reply.send(success(result.items, result.meta));
  };
  room = async (request: FastifyRequest<{ Params: UuidParams }>, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.room(request.params.id)));
  };
  matches = async (
    request: FastifyRequest<{ Querystring: AdminMatchesQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.service.matches(request.query);
    reply.send(success(result.items, result.meta));
  };
  players = async (
    request: FastifyRequest<{ Querystring: AdminPlayersQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.service.players(request.query);
    reply.send(success(result.items, result.meta));
  };
  player = async (
    request: FastifyRequest<{ Params: UserIdParams }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.player(request.params.userId)));
  };
  restrictions = async (
    request: FastifyRequest<{ Params: UserIdParams; Body: UpdatePlayerRestrictionsInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(
      success(
        await this.service.updateRestrictions(
          request.params.userId,
          request.body,
          request.user.sub,
        ),
      ),
    );
  };
  reports = async (
    request: FastifyRequest<{ Querystring: AdminReportsQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.service.reports(request.query);
    reply.send(success(result.items, result.meta));
  };
  resolveReport = async (
    request: FastifyRequest<{ Params: UuidParams; Body: ResolveReportInput }>,
    reply: FastifyReply,
  ): Promise<void> => {
    reply.send(success(await this.service.resolveReport(request.params.id, request.body, request.user.sub)));
  };
  subscriptionAnalytics = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.subscriptionAnalytics()));
  };
  paymentEvents = async (
    request: FastifyRequest<{ Querystring: AdminPaymentEventsQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.service.paymentEvents(request.query);
    reply.send(success(result.items, result.meta));
  };
  monitoring = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send(success(await this.service.monitoring()));
  };
  auditLogs = async (
    request: FastifyRequest<{ Querystring: LudoHistoryQuery }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await this.service.auditLogs(request.query.page, request.query.limit);
    reply.send(success(result.items, result.meta));
  };
}
