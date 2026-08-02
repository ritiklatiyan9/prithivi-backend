import { Prisma, type PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../../common/errors.js";
import type { PageMeta } from "../../../common/response.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import type {
  AdminMatchesQuery,
  AdminPaymentEventsQuery,
  AdminPlayersQuery,
  AdminReportsQuery,
  AdminRoomsQuery,
  ResolveReportInput,
  UpdateLudoConfigInput,
  UpdatePlayerRestrictionsInput,
} from "../schemas/ludo.schema.js";
import type { LudoRealtimeHub } from "../sockets/ludo-hub.js";

const meta = (page: number, limit: number, total: number): PageMeta => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});

export class LudoAdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly hub: LudoRealtimeHub,
  ) {}

  async overview(): Promise<Record<string, unknown>> {
    const [activeRooms, queuedPlayers, completedMatches, abandonedMatches, completedRows, players, disconnectedNow] =
      await Promise.all([
        this.prisma.ludoRoom.count({ where: { status: "ACTIVE" } }),
        this.prisma.ludoQueueEntry.count({ where: { status: "QUEUED" } }),
        this.prisma.ludoRoom.count({ where: { status: "COMPLETED" } }),
        this.prisma.ludoRoom.count({ where: { status: { in: ["ABANDONED", "EXPIRED"] } } }),
        this.prisma.ludoRoom.findMany({
          where: { status: "COMPLETED", startedAt: { not: null }, completedAt: { not: null } },
          select: { startedAt: true, completedAt: true },
          orderBy: { completedAt: "desc" },
          take: 5_000,
        }),
        this.prisma.ludoStatistics.aggregate({
          _sum: { totalMatches: true, wins: true, disconnects: true, forfeits: true },
          _count: { userId: true },
        }),
        this.prisma.ludoPlayer.count({ where: { status: "DISCONNECTED" } }),
      ]);
    const totalPlayerMatches = players._sum.totalMatches ?? 0;
    const disconnects = players._sum.disconnects ?? 0;
    const forfeits = players._sum.forfeits ?? 0;
    const averageMatchDurationSeconds = completedRows.length
      ? Math.round(
          completedRows.reduce(
            (sum, row) => sum + ((row.completedAt?.getTime() ?? 0) - (row.startedAt?.getTime() ?? 0)) / 1000,
            0,
          ) / completedRows.length,
        )
      : 0;
    const socket = this.hub.metrics();
    return {
      onlinePlayers: socket.authenticated,
      matchmakingPlayers: queuedPlayers,
      activeRooms,
      completedMatches,
      abandonedMatches,
      averageMatchDurationSeconds,
      reconnectionRate: disconnects === 0 ? 100 : Math.max(0, Math.round(((disconnects - disconnectedNow) / disconnects) * 10000) / 100),
      forfeitRate: totalPlayerMatches === 0 ? 0 : Math.round((forfeits / totalPlayerMatches) * 10000) / 100,
      websocketHealth: socket.errors === 0 ? "HEALTHY" : "DEGRADED",
      websocketConnections: socket.connections,
      websocketErrors: socket.errors,
      generatedAt: new Date().toISOString(),
    };
  }

  async config(): Promise<Record<string, unknown>> {
    const settings = (await this.settings.list()).filter((setting) => setting.key.startsWith("game.ludo."));
    return {
      values: Object.fromEntries(
        settings.map((setting) => {
          let value: unknown = setting.value;
          if (setting.type === "BOOLEAN") value = setting.value === "true";
          if (setting.type === "NUMBER") value = Number(setting.value);
          if (setting.key === "game.ludo.quickMessages") {
            try {
              value = JSON.parse(setting.value) as unknown;
            } catch {
              value = [];
            }
          }
          return [setting.key, value];
        }),
      ),
    };
  }

  async updateConfig(input: UpdateLudoConfigInput, adminId: string): Promise<Record<string, unknown>> {
    await this.settings.update(input, adminId);
    return this.config();
  }

  async rooms(query: AdminRoomsQuery): Promise<{ items: unknown[]; meta: PageMeta }> {
    const where: Prisma.LudoRoomWhereInput = {
      ...(query.status ? { status: query.status } : { status: { in: ["MATCHED", "WAITING_READY", "ACTIVE"] } }),
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.search
        ? {
            OR: [
              { id: { contains: query.search, mode: "insensitive" } },
              { players: { some: { user: { name: { contains: query.search, mode: "insensitive" } } } } },
              { players: { some: { user: { email: { contains: query.search, mode: "insensitive" } } } } },
            ],
          }
        : {}),
    };
    return this.roomList(where, query.page, query.limit);
  }

  async matches(query: AdminMatchesQuery): Promise<{ items: unknown[]; meta: PageMeta }> {
    const where: Prisma.LudoRoomWhereInput = {
      status: query.status
        ? query.status
        : { in: ["COMPLETED", "CANCELLED", "ABANDONED", "EXPIRED"] },
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { id: { contains: query.search, mode: "insensitive" } },
              { players: { some: { user: { name: { contains: query.search, mode: "insensitive" } } } } },
              { players: { some: { user: { email: { contains: query.search, mode: "insensitive" } } } } },
            ],
          }
        : {}),
    };
    return this.roomList(where, query.page, query.limit);
  }

  private async roomList(
    where: Prisma.LudoRoomWhereInput,
    page: number,
    limit: number,
  ): Promise<{ items: unknown[]; meta: PageMeta }> {
    const [rows, total] = await Promise.all([
      this.prisma.ludoRoom.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          players: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
        },
      }),
      this.prisma.ludoRoom.count({ where }),
    ]);
    return { items: rows.map((row) => this.roomDto(row)), meta: meta(page, limit, total) };
  }

  async room(id: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.ludoRoom.findUnique({
      where: { id },
      include: {
        players: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
        actions: { orderBy: { stateVersion: "asc" }, take: 500 },
        chatMessages: { orderBy: { createdAt: "asc" }, take: 200 },
        reports: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!row) throw new NotFoundError("Ludo room not found");
    return {
      ...this.roomDto(row),
      state: row.state,
      configSnapshot: row.configSnapshot,
      actions: row.actions,
      chatMessages: row.chatMessages,
      reports: row.reports,
    };
  }

  async players(query: AdminPlayersQuery): Promise<{ items: unknown[]; meta: PageMeta }> {
    const where: Prisma.UserWhereInput = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { email: { contains: query.search, mode: "insensitive" } },
            { id: { contains: query.search, mode: "insensitive" } },
          ],
          ludoPlayers: { some: {} },
        }
      : { ludoPlayers: { some: {} } };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          ludoStatistics: true,
          ludoEntitlement: true,
          ludoRestrictions: { where: { revokedAt: null }, orderBy: { createdAt: "desc" } },
          ludoPlayers: { orderBy: { joinedAt: "desc" }, take: 1, include: { room: { select: { id: true, status: true } } } },
          _count: { select: { ludoReportsAgainst: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map((row) => this.playerDto(row)), meta: meta(query.page, query.limit, total) };
  }

  async player(userId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        ludoStatistics: true,
        ludoEntitlement: true,
        ludoRestrictions: { orderBy: { createdAt: "desc" } },
        ludoSubscriptions: { orderBy: { createdAt: "desc" } },
        ludoReportsAgainst: { orderBy: { createdAt: "desc" }, take: 100 },
        ludoPlayers: { orderBy: { joinedAt: "desc" }, take: 50, include: { room: { select: { id: true, mode: true, status: true, createdAt: true } } } },
        _count: { select: { ludoReportsAgainst: true } },
      },
    });
    if (!row) throw new NotFoundError("Ludo player not found");
    return this.playerDto(row);
  }

  async updateRestrictions(
    userId: string,
    input: UpdatePlayerRestrictionsInput,
    adminId: string,
  ): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundError("Ludo player not found");
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const apply = async (
        type: "GAME_ACCESS" | "COMMUNICATION",
        value: string | null | undefined,
      ): Promise<void> => {
        if (value === undefined) return;
        await tx.ludoRestriction.updateMany({
          where: { userId, type, revokedAt: null },
          data: { revokedAt: now },
        });
        if (value !== null && new Date(value).getTime() > now.getTime()) {
          await tx.ludoRestriction.create({
            data: { userId, type, reason: input.reason, expiresAt: new Date(value), createdById: adminId },
          });
        }
      };
      await apply("GAME_ACCESS", input.gameSuspendedUntil);
      await apply("COMMUNICATION", input.chatMutedUntil);
    });
    const restrictions = await this.prisma.ludoRestriction.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    });
    return {
      userId,
      gameSuspendedUntil: restrictions.find((row) => row.type === "GAME_ACCESS")?.expiresAt?.toISOString() ?? null,
      chatMutedUntil: restrictions.find((row) => row.type === "COMMUNICATION")?.expiresAt?.toISOString() ?? null,
      restrictions,
    };
  }

  async reports(query: AdminReportsQuery): Promise<{ items: unknown[]; meta: PageMeta }> {
    const where: Prisma.LudoReportWhereInput = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.ludoReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          reporter: { select: { id: true, name: true, email: true } },
          targetUser: { select: { id: true, name: true, email: true } },
          resolvedBy: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.ludoReport.count({ where }),
    ]);
    return { items: rows, meta: meta(query.page, query.limit, total) };
  }

  async resolveReport(id: string, input: ResolveReportInput, adminId: string): Promise<unknown> {
    const existing = await this.prisma.ludoReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Ludo report not found");
    const resolution = input.resolution.trim().toUpperCase();
    return this.prisma.ludoReport.update({
      where: { id },
      data: {
        status: resolution === "DISMISSED" ? "DISMISSED" : "RESOLVED",
        resolution: input.note ? `${input.resolution}: ${input.note}` : input.resolution,
        resolvedById: adminId,
        resolvedAt: new Date(),
      },
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        targetUser: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async subscriptionAnalytics(): Promise<Record<string, unknown>> {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const expiringAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [players, plusUsers, proUsers, newSubscriptions, renewals, failedPayments, cancellations, expiringSubscriptions, lastWebhook] = await Promise.all([
      this.prisma.user.count({ where: { ludoPlayers: { some: {} } } }),
      this.prisma.ludoEntitlement.count({ where: { plan: "PLUS", status: "ACTIVE", expiresAt: { gt: now } } }),
      this.prisma.ludoEntitlement.count({ where: { plan: "PRO", status: "ACTIVE", expiresAt: { gt: now } } }),
      this.prisma.ludoSubscription.count({ where: { createdAt: { gte: monthAgo } } }),
      this.prisma.ludoPaymentEvent.count({ where: { type: { contains: "charged" }, status: "PROCESSED" } }),
      this.prisma.ludoPaymentEvent.count({ where: { status: "FAILED", createdAt: { gte: monthAgo } } }),
      this.prisma.ludoSubscription.count({ where: { cancelledAt: { gte: monthAgo } } }),
      this.prisma.ludoEntitlement.count({ where: { status: "ACTIVE", expiresAt: { gt: now, lte: expiringAt } } }),
      this.prisma.ludoPaymentEvent.findFirst({ orderBy: { createdAt: "desc" } }),
    ]);
    return {
      freeUsers: Math.max(0, players - plusUsers - proUsers),
      plan349Users: plusUsers,
      plan499Users: proUsers,
      plusUsers,
      proUsers,
      newSubscriptions,
      renewals,
      failedPayments,
      cancellations,
      expiringSubscriptions,
      razorpayWebhookHealth: failedPayments === 0 ? "HEALTHY" : "DEGRADED",
      webhookLastReceivedAt: lastWebhook?.createdAt.toISOString() ?? null,
      generatedAt: now.toISOString(),
    };
  }

  async paymentEvents(query: AdminPaymentEventsQuery): Promise<{ items: unknown[]; meta: PageMeta }> {
    const where: Prisma.LudoPaymentEventWhereInput = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.ludoPaymentEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { subscription: { select: { userId: true, plan: true, status: true, razorpaySubscriptionId: true } } },
      }),
      this.prisma.ludoPaymentEvent.count({ where }),
    ]);
    return { items: rows, meta: meta(query.page, query.limit, total) };
  }

  async monitoring(): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [matchmakingFailures, roomCreationFailures, paymentWebhookErrors] = await Promise.all([
      this.prisma.ludoQueueEntry.count({ where: { status: "TIMED_OUT", updatedAt: { gte: since } } }),
      this.prisma.ludoRoom.count({ where: { status: { in: ["EXPIRED", "ABANDONED"] }, createdAt: { gte: since } } }),
      this.prisma.ludoPaymentEvent.count({ where: { status: "FAILED", createdAt: { gte: since } } }),
    ]);
    const socket = this.hub.metrics();
    return {
      socketConnections: socket.connections,
      socketErrors: socket.errors,
      matchmakingFailures,
      roomCreationFailures,
      desynchronisationIncidents: 0,
      paymentWebhookErrors,
      voiceSignallingErrors: 0,
      websocketHealth: socket.errors === 0 ? "HEALTHY" : "DEGRADED",
      incidents: [],
      generatedAt: new Date().toISOString(),
    };
  }

  async auditLogs(page: number, limit: number): Promise<{ items: unknown[]; meta: PageMeta }> {
    const where: Prisma.AuditLogWhereInput = { path: { contains: "/admin/game" } };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: rows, meta: meta(page, limit, total) };
  }

  private roomDto(row: {
    id: string;
    mode: string;
    status: string;
    stateVersion: number;
    acceptanceDeadline: Date | null;
    turnDeadline: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    cancelledReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    state?: Prisma.JsonValue;
    players: Array<{
      userId: string;
      seat: number;
      color: string;
      status: string;
      finishedPosition: number | null;
      captures: number;
      diceRolls: number;
      disconnectCount: number;
      user: { id: string; name: string; email: string; avatarUrl: string | null };
    }>;
  }): Record<string, unknown> {
    const winner = row.players.find((player) => player.finishedPosition === 1)?.user ?? null;
    const durationSeconds = row.startedAt
      ? Math.max(0, Math.round(((row.completedAt ?? new Date()).getTime() - row.startedAt.getTime()) / 1000))
      : 0;
    const engineState = (row.state ?? {}) as Record<string, unknown>;
    const enginePlayers = Array.isArray(engineState.players)
      ? (engineState.players as Array<Record<string, unknown>>)
      : [];
    const currentSeat = typeof engineState.currentTurnSeat === "number" ? engineState.currentTurnSeat : null;
    const currentTurnUserId = currentSeat === null
      ? null
      : (enginePlayers.find((player) => player.seat === currentSeat)?.userId as string | undefined) ?? null;
    const players = row.players.map((player) => ({
      ...player.user,
      userId: player.userId,
      user: player.user,
      seat: player.seat,
      color: player.color,
      status: player.status,
      position: player.finishedPosition,
      captures: player.captures,
      connected: this.hub.session(player.userId)?.gameId === row.id,
    }));
    return {
      id: row.id,
      roomId: row.id,
      mode: row.mode,
      status: row.status,
      stateVersion: row.stateVersion,
      currentTurnUserId,
      durationSeconds,
      connectedPlayers: players.filter((player) => player.connected).length,
      winnerId: winner?.id ?? null,
      winner,
      result: row.status,
      disconnects: row.players.reduce((sum, player) => sum + player.disconnectCount, 0),
      forfeits: row.players.filter((player) => player.status === "FORFEITED").length,
      acceptanceDeadline: row.acceptanceDeadline?.toISOString() ?? null,
      turnDeadline: row.turnDeadline?.toISOString() ?? null,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledReason: row.cancelledReason,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      players,
    };
  }

  private playerDto(row: Record<string, unknown>): Record<string, unknown> {
    const value = row as {
      id: string;
      name: string;
      email: string;
      avatarUrl: string | null;
      updatedAt: Date;
      ludoStatistics?: Record<string, unknown> | null;
      ludoEntitlement?: { plan: string; status: string; expiresAt: Date | null } | null;
      ludoRestrictions?: Array<{ type: string; reason: string; expiresAt: Date | null; revokedAt: Date | null }>;
      ludoPlayers?: Array<{ roomId: string; status: string; finishedPosition: number | null; room: Record<string, unknown> }>;
      ludoReportsAgainst?: unknown[];
      _count?: { ludoReportsAgainst: number };
    };
    const restrictions = (value.ludoRestrictions ?? []).filter(
      (restriction) => !restriction.revokedAt && (!restriction.expiresAt || restriction.expiresAt > new Date()),
    );
    const activeRoom = value.ludoPlayers?.find((player) =>
      ["MATCHED", "ACCEPTED", "READY", "ACTIVE", "DISCONNECTED"].includes(player.status),
    );
    return {
      id: value.id,
      userId: value.id,
      name: value.name,
      email: value.email,
      avatarUrl: value.avatarUrl,
      online: this.hub.session(value.id) !== undefined,
      plan: value.ludoEntitlement?.plan ?? "FREE",
      subscriptionPlan: value.ludoEntitlement?.plan ?? "FREE",
      entitlement: value.ludoEntitlement ?? { plan: "FREE", status: "FREE" },
      statistics: value.ludoStatistics ?? {},
      stats: value.ludoStatistics ?? {},
      restrictions: {
        gameSuspendedUntil: restrictions.find((restriction) => restriction.type === "GAME_ACCESS")?.expiresAt?.toISOString() ?? null,
        chatMutedUntil: restrictions.find((restriction) => restriction.type === "COMMUNICATION")?.expiresAt?.toISOString() ?? null,
        reason: restrictions[0]?.reason ?? null,
      },
      reportCount: value._count?.ludoReportsAgainst ?? value.ludoReportsAgainst?.length ?? 0,
      activeRoomId: activeRoom?.roomId ?? null,
      recentMatches: (value.ludoPlayers ?? []).slice(0, 20).map((player) => ({
        id: player.roomId,
        roomId: player.roomId,
        ...player.room,
        position: player.finishedPosition,
      })),
      reports: value.ludoReportsAgainst ?? [],
      lastSeenAt: value.updatedAt.toISOString(),
    };
  }
}
