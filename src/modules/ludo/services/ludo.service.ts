import { randomInt, randomUUID } from "node:crypto";
import { Prisma, type LudoGameMode, type PrismaClient } from "@prisma/client";
import type { Env } from "../../../config/env.js";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../common/errors.js";
import type { PageMeta } from "../../../common/response.js";
import { generateOpaqueToken, hashToken } from "../../../utils/tokens.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import {
  applyMove,
  applyRoll,
  completedPawnCount,
  createInitialState,
  expireTurn,
  forfeitPlayer,
  startGame,
  type LudoEngineState,
  type LudoMode,
} from "../engine/ludo.js";
import type {
  LudoHistoryQuery,
  LudoPlanCode,
  LudoServerEvent,
  LudoServerEventType,
} from "../schemas/ludo.schema.js";
import type { LudoRealtimeHub } from "../sockets/ludo-hub.js";
import { ludoPurchaseAvailability, razorpayCredentials } from "./ludo-subscription-catalog.js";

interface LudoRuntimeConfig {
  enabled: boolean;
  matchmakingEnabled: boolean;
  twoPlayerEnabled: boolean;
  threePlayerEnabled: boolean;
  fourPlayerEnabled: boolean;
  maintenanceMode: boolean;
  textChatEnabled: boolean;
  voiceEnabled: boolean;
  turnDurationSeconds: number;
  reconnectionGraceSeconds: number;
  matchAcceptanceSeconds: number;
  queueTimeoutSeconds: number;
  inactiveForfeitTurns: number;
  chatMaxCharacters: number;
  chatRateLimitPer10Seconds: number;
  minimumSupportedAppVersion: string;
  quickMessages: string[];
  freeReactions: string[];
  engine: {
    pawnsPerPlayer: number;
    threeConsecutiveSixes: boolean;
    extraTurnOnSix: boolean;
    extraTurnOnCapture: boolean;
  };
}

interface EffectiveEntitlement {
  plan: LudoPlanCode;
  status: string;
  startsAt: string | null;
  expiresAt: string | null;
  subscriptionId: string | null;
  entitlements: { quickChat: true; textChat: boolean; voiceChat: boolean };
}

interface MatchCreation {
  roomId: string;
  stateVersion: number;
  players: Array<{ userId: string; resumeToken: string }>;
}

interface RoomMutationResult {
  event: LudoServerEvent;
  userIds: string[];
  completed: boolean;
  clearedUserIds: string[];
}

interface SnapshotEntitlementRow {
  plan: LudoPlanCode;
  status: string;
  startsAt: Date | null;
  expiresAt: Date | null;
}

interface SnapshotPlayerRow {
  userId: string;
  seat: number;
  color: string;
  status: string;
  finishedPosition: number | null;
  user: {
    id: string;
    name: string;
    avatarUrl: string | null;
    ludoEntitlement: SnapshotEntitlementRow | null;
  };
}

const asState = (value: Prisma.JsonValue): LudoEngineState => value as unknown as LudoEngineState;
const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const roomPlayerCount = (mode: LudoGameMode): number =>
  mode === "TWO_PLAYER" ? 2 : mode === "THREE_PLAYER" ? 3 : 4;
const ACTIVE_ROOM_STATUSES = ["MATCHED", "WAITING_READY", "ACTIVE"] as const;
const QUICK_REACTIONS = ["SMILE", "CLAP", "GOOD_GAME"] as const;

const parseStringList = (value: string, fallback: string[]): string[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      const values = parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toUpperCase())
        .filter((item) => /^[A-Z0-9_]{1,32}$/.test(item));
      if (values.length > 0) return [...new Set(values)].slice(0, 10);
    }
  } catch {
    // A malformed admin override falls back to safe built-ins.
  }
  return fallback;
};

export class LudoService {
  private readonly typingActivity = new Map<string, { typing: boolean; sentAt: number }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly hub: LudoRealtimeHub,
    private readonly env: Env,
  ) {}

  private async runtimeConfig(): Promise<LudoRuntimeConfig> {
    const [
      enabled,
      matchmakingEnabled,
      twoPlayerEnabled,
      threePlayerEnabled,
      fourPlayerEnabled,
      maintenanceMode,
      textChatEnabled,
      voiceEnabled,
      turnDurationSeconds,
      reconnectionGraceSeconds,
      matchAcceptanceSeconds,
      queueTimeoutSeconds,
      inactiveForfeitTurns,
      chatMaxCharacters,
      chatRateLimitPer10Seconds,
      minimumSupportedAppVersion,
      quickMessagesRaw,
      freeReactionCount,
      pawnsPerPlayer,
      threeConsecutiveSixes,
      extraTurnOnSix,
      extraTurnOnCapture,
    ] = await Promise.all([
      this.settings.getBoolean("game.ludo.enabled"),
      this.settings.getBoolean("game.ludo.matchmakingEnabled"),
      this.settings.getBoolean("game.ludo.twoPlayerEnabled"),
      this.settings.getBoolean("game.ludo.threePlayerEnabled"),
      this.settings.getBoolean("game.ludo.fourPlayerEnabled"),
      this.settings.getBoolean("game.ludo.maintenanceMode"),
      this.settings.getBoolean("game.ludo.textChatEnabled"),
      this.settings.getBoolean("game.ludo.voiceEnabled"),
      this.settings.getNumber("game.ludo.turnDurationSeconds"),
      this.settings.getNumber("game.ludo.reconnectionGraceSeconds"),
      this.settings.getNumber("game.ludo.matchAcceptanceSeconds"),
      this.settings.getNumber("game.ludo.queueTimeoutSeconds"),
      this.settings.getNumber("game.ludo.inactiveForfeitTurns"),
      this.settings.getNumber("game.ludo.chatMaxCharacters"),
      this.settings.getNumber("game.ludo.chatRateLimitPer10Seconds"),
      this.settings.getString("game.ludo.minimumSupportedAppVersion"),
      this.settings.getString("game.ludo.quickMessages"),
      this.settings.getNumber("game.ludo.freeReactionCount"),
      this.settings.getNumber("game.ludo.pawnsPerPlayer"),
      this.settings.getBoolean("game.ludo.threeSixesRule"),
      this.settings.getBoolean("game.ludo.extraTurnOnSix"),
      this.settings.getBoolean("game.ludo.extraTurnOnCapture"),
    ]);
    return {
      enabled,
      matchmakingEnabled,
      twoPlayerEnabled,
      threePlayerEnabled,
      fourPlayerEnabled,
      maintenanceMode,
      textChatEnabled,
      voiceEnabled,
      turnDurationSeconds,
      reconnectionGraceSeconds,
      matchAcceptanceSeconds,
      queueTimeoutSeconds,
      inactiveForfeitTurns,
      chatMaxCharacters,
      chatRateLimitPer10Seconds,
      minimumSupportedAppVersion,
      quickMessages: parseStringList(quickMessagesRaw, ["HELLO", "HI"]),
      freeReactions: QUICK_REACTIONS.slice(0, freeReactionCount),
      engine: {
        pawnsPerPlayer,
        threeConsecutiveSixes,
        extraTurnOnSix,
        extraTurnOnCapture,
      },
    };
  }

  async effectiveEntitlement(userId: string): Promise<EffectiveEntitlement> {
    const row = await this.prisma.ludoEntitlement.findUnique({ where: { userId } });
    const active =
      row !== null &&
      row.plan !== "FREE" &&
      row.status === "ACTIVE" &&
      row.startsAt !== null &&
      row.startsAt.getTime() <= Date.now() &&
      row.expiresAt !== null &&
      row.expiresAt.getTime() > Date.now();
    const plan: LudoPlanCode = active ? row.plan : "FREE";
    return {
      plan,
      status: active ? "ACTIVE" : "FREE",
      startsAt: active ? (row.startsAt?.toISOString() ?? null) : null,
      expiresAt: active ? (row.expiresAt?.toISOString() ?? null) : null,
      subscriptionId: active ? row.sourceSubscriptionId : null,
      entitlements: {
        quickChat: true,
        textChat: plan === "PLUS" || plan === "PRO",
        voiceChat: plan === "PRO",
      },
    };
  }

  private effectivePlan(row: SnapshotEntitlementRow | null, now = Date.now()): LudoPlanCode {
    return row !== null &&
      row.plan !== "FREE" &&
      row.status === "ACTIVE" &&
      row.startsAt !== null &&
      row.startsAt.getTime() <= now &&
      row.expiresAt !== null &&
      row.expiresAt.getTime() > now
      ? row.plan
      : "FREE";
  }

  async getConfig(userId: string): Promise<Record<string, unknown>> {
    const [config, entitlement, settingKeyId, settingKeySecret] = await Promise.all([
      this.runtimeConfig(),
      this.effectiveEntitlement(userId),
      this.settings.getString("payment.razorpay.keyId"),
      this.settings.getString("payment.razorpay.keySecret"),
    ]);
    const voiceIceServers =
      config.voiceEnabled && entitlement.entitlements.voiceChat ? this.voiceIceServers() : [];
    const purchaseAvailability = ludoPurchaseAvailability(
      this.env,
      razorpayCredentials(this.env, {
        keyId: settingKeyId,
        keySecret: settingKeySecret,
      }) ?? undefined,
    );
    return {
      enabled: config.enabled,
      matchmakingEnabled: config.matchmakingEnabled,
      modes: [
        { mode: "TWO_PLAYER", enabled: config.twoPlayerEnabled, players: 2 },
        { mode: "THREE_PLAYER", enabled: config.threePlayerEnabled, players: 3 },
        { mode: "FOUR_PLAYER", enabled: config.fourPlayerEnabled, players: 4 },
      ],
      modeAvailability: {
        TWO_PLAYER: config.twoPlayerEnabled,
        THREE_PLAYER: config.threePlayerEnabled,
        FOUR_PLAYER: config.fourPlayerEnabled,
      },
      maintenanceMode: config.maintenanceMode,
      turnDurationSeconds: config.turnDurationSeconds,
      reconnectionGraceSeconds: config.reconnectionGraceSeconds,
      matchAcceptanceSeconds: config.matchAcceptanceSeconds,
      queueTimeoutSeconds: config.queueTimeoutSeconds,
      rules: config.engine,
      quickMessages: config.quickMessages,
      freeReactions: config.freeReactions,
      communication: {
        quickMessages: config.quickMessages,
        freeReactions: config.freeReactions,
        textChatEnabled: config.textChatEnabled,
        voiceEnabled: config.voiceEnabled,
      },
      subscriptionPurchaseEnabled: purchaseAvailability.purchaseEnabled,
      purchases: {
        enabled: purchaseAvailability.purchaseEnabled,
        checkoutConfigured: purchaseAvailability.checkoutConfigured,
        plans: {
          PLUS: {
            purchasable: purchaseAvailability.plans.PLUS.purchasable,
            checkoutConfigured: purchaseAvailability.plans.PLUS.checkoutConfigured,
            availabilityReason: purchaseAvailability.plans.PLUS.availabilityReason,
          },
          PRO: {
            purchasable: purchaseAvailability.plans.PRO.purchasable,
            checkoutConfigured: purchaseAvailability.plans.PRO.checkoutConfigured,
            availabilityReason: purchaseAvailability.plans.PRO.availabilityReason,
          },
        },
      },
      minimumSupportedAppVersion: config.minimumSupportedAppVersion || null,
      entitlement,
      voiceIceServers,
      socketPath: `${this.env.API_PREFIX}/ludo/socket`,
    };
  }

  private voiceIceServers(): Array<Record<string, unknown>> {
    const split = (value?: string): string[] =>
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const servers: Array<Record<string, unknown>> = [];
    const stun = split(this.env.LUDO_STUN_URLS);
    if (stun.length > 0) servers.push({ urls: stun });
    const turn = split(this.env.LUDO_TURN_URLS);
    if (turn.length > 0 && this.env.LUDO_TURN_USERNAME && this.env.LUDO_TURN_CREDENTIAL) {
      servers.push({
        urls: turn,
        username: this.env.LUDO_TURN_USERNAME,
        credential: this.env.LUDO_TURN_CREDENTIAL,
      });
    }
    return servers;
  }

  async assertSocketUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });
    if (!user?.isActive) throw new ForbiddenError("This account is not allowed to play");
    await this.assertNotRestricted(userId, "GAME_ACCESS");
  }

  private async assertNotRestricted(
    userId: string,
    type: "GAME_ACCESS" | "COMMUNICATION" | "TEXT_CHAT" | "VOICE_CHAT",
  ): Promise<void> {
    const restriction = await this.prisma.ludoRestriction.findFirst({
      where: {
        userId,
        type,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (restriction) throw new ForbiddenError("This game capability is temporarily restricted");
  }

  private async assertAvailable(mode?: LudoMode): Promise<LudoRuntimeConfig> {
    const config = await this.runtimeConfig();
    if (!config.enabled) throw new ForbiddenError("Ludo is currently disabled");
    if (config.maintenanceMode)
      throw new AppError("Ludo is under maintenance", 503, "LUDO_MAINTENANCE");
    if (!config.matchmakingEnabled && mode) throw new ForbiddenError("Matchmaking is disabled");
    if (mode === "TWO_PLAYER" && !config.twoPlayerEnabled)
      throw new ForbiddenError("Two-player mode is disabled");
    if (mode === "THREE_PLAYER" && !config.threePlayerEnabled)
      throw new ForbiddenError("Three-player mode is disabled");
    if (mode === "FOUR_PLAYER" && !config.fourPlayerEnabled)
      throw new ForbiddenError("Four-player mode is disabled");
    return config;
  }

  private async lock(
    tx: Prisma.TransactionClient,
    key: string,
    namespace = 20260802,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, ${namespace}))`;
  }

  private async dbNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    if (!rows[0]) throw new AppError("Database time unavailable", 503, "DATABASE_TIME_UNAVAILABLE");
    return rows[0].now;
  }

  async joinMatchmaking(
    userId: string,
    input: { mode: LudoMode; region?: string; pingMs?: number },
  ): Promise<LudoServerEvent> {
    const config = await this.assertAvailable(input.mode);
    await this.assertSocketUser(userId);
    const entry = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `ludo:user:${userId}`);
      const now = await this.dbNow(tx);
      const activePlayer = await tx.ludoPlayer.findFirst({ where: { activeKey: userId } });
      if (activePlayer) throw new ConflictError("You are already in an active Ludo match");
      const existing = await tx.ludoQueueEntry.findUnique({ where: { userId } });
      if (
        existing?.status === "QUEUED" &&
        existing.mode === input.mode &&
        existing.expiresAt > now
      ) {
        return existing;
      }
      return tx.ludoQueueEntry.upsert({
        where: { userId },
        create: {
          userId,
          mode: input.mode,
          status: "QUEUED",
          region: input.region,
          pingMs: input.pingMs,
          joinedAt: now,
          expiresAt: new Date(now.getTime() + config.queueTimeoutSeconds * 1000),
        },
        update: {
          mode: input.mode,
          status: "QUEUED",
          region: input.region,
          pingMs: input.pingMs,
          joinedAt: now,
          expiresAt: new Date(now.getTime() + config.queueTimeoutSeconds * 1000),
          matchedRoomId: null,
          acceptedAt: null,
        },
      });
    });

    const joined = this.hub.event("matchmaking.joined", {
      queueId: entry.id,
      mode: entry.mode,
      joinedAt: entry.joinedAt.toISOString(),
    });
    this.hub.send(userId, joined);
    const match = await this.tryCreateMatch(input.mode, config);
    if (match) this.publishMatchFound(match);
    return joined;
  }

  async leaveMatchmaking(userId: string): Promise<LudoServerEvent> {
    const entry = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `ludo:user:${userId}`);
      const existing = await tx.ludoQueueEntry.findUnique({ where: { userId } });
      if (!existing || existing.status !== "QUEUED") return existing;
      return tx.ludoQueueEntry.update({ where: { userId }, data: { status: "CANCELLED" } });
    });
    const event = this.hub.event("matchmaking.left", { status: entry?.status ?? "NOT_QUEUED" });
    this.hub.send(userId, event);
    return event;
  }

  private async tryCreateMatch(
    mode: LudoGameMode,
    config: LudoRuntimeConfig,
  ): Promise<MatchCreation | null> {
    const online = this.hub.onlineUserIds();
    if (online.length < roomPlayerCount(mode)) return null;
    return this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, `ludo:queue:${mode}`, 20260803);
        const now = await this.dbNow(tx);
        await tx.ludoQueueEntry.updateMany({
          where: { mode, status: "QUEUED", expiresAt: { lte: now } },
          data: { status: "TIMED_OUT" },
        });
        const candidates = await tx.ludoQueueEntry.findMany({
          where: { mode, status: "QUEUED", expiresAt: { gt: now }, userId: { in: online } },
          orderBy: { joinedAt: "asc" },
          take: roomPlayerCount(mode),
          include: { user: { select: { isActive: true } } },
        });
        if (candidates.length !== roomPlayerCount(mode)) return null;

        for (const userId of candidates.map((candidate) => candidate.userId).sort()) {
          await this.lock(tx, `ludo:user:${userId}`);
        }
        const lockedEntries = await tx.ludoQueueEntry.findMany({
          where: { id: { in: candidates.map((candidate) => candidate.id) } },
        });
        if (
          lockedEntries.length !== candidates.length ||
          lockedEntries.some(
            (entry) => entry.status !== "QUEUED" || entry.mode !== mode || entry.expiresAt <= now,
          ) ||
          candidates.some((candidate) => !candidate.user.isActive)
        ) {
          return null;
        }
        const activeCount = await tx.ludoPlayer.count({
          where: { activeKey: { in: candidates.map((candidate) => candidate.userId) } },
        });
        if (activeCount > 0) return null;

        const roomId = randomUUID();
        const engine = createInitialState({
          gameId: roomId,
          mode,
          userIds: candidates.map((candidate) => candidate.userId),
          now: now.toISOString(),
          config: config.engine,
          startingSeat: randomInt(candidates.length),
        });
        const deadline = new Date(now.getTime() + config.matchAcceptanceSeconds * 1000);
        await tx.ludoRoom.create({
          data: {
            id: roomId,
            mode,
            state: asJson(engine),
            configSnapshot: asJson(config),
            acceptanceDeadline: deadline,
            players: {
              create: engine.players.map((player) => {
                const resumeToken = generateOpaqueToken();
                return {
                  userId: player.userId,
                  seat: player.seat,
                  color: player.color,
                  activeKey: player.userId,
                  resumeTokenHash: hashToken(resumeToken),
                };
              }),
            },
          },
        });
        const claimed = await tx.ludoQueueEntry.updateMany({
          where: {
            userId: { in: candidates.map((candidate) => candidate.userId) },
            status: "QUEUED",
          },
          data: { status: "MATCHED", matchedRoomId: roomId },
        });
        if (claimed.count !== candidates.length) {
          throw new ConflictError("Matchmaking entries changed concurrently");
        }

        // Rotate hashes once more while returning the corresponding plaintext
        // tokens; plaintext resume credentials are never persisted.
        const players: MatchCreation["players"] = [];
        for (const candidate of candidates) {
          const resumeToken = generateOpaqueToken();
          await tx.ludoPlayer.update({
            where: { roomId_userId: { roomId, userId: candidate.userId } },
            data: { resumeTokenHash: hashToken(resumeToken) },
          });
          players.push({ userId: candidate.userId, resumeToken });
        }
        return { roomId, stateVersion: 0, players };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
    );
  }

  private publishMatchFound(match: MatchCreation): void {
    for (const player of match.players) {
      this.hub.setGame(player.userId, match.roomId);
      this.hub.send(
        player.userId,
        this.hub.event(
          "match.found",
          { gameId: match.roomId, resumeToken: player.resumeToken },
          match.roomId,
          match.stateVersion,
        ),
      );
    }
  }

  async acceptMatch(
    userId: string,
    gameId: string,
    actionId: string,
    expectedStateVersion: number,
  ): Promise<LudoServerEvent> {
    const config = await this.assertAvailable();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `ludo:room:${gameId}`, 20260804);
      const duplicate = await tx.ludoAction.findUnique({
        where: { roomId_actionId: { roomId: gameId, actionId } },
      });
      if (duplicate)
        return { event: duplicate.serverEvent as unknown as LudoServerEvent, userIds: [] };
      const room = await tx.ludoRoom.findUnique({
        where: { id: gameId },
        include: { players: true },
      });
      if (!room || !room.players.some((player) => player.userId === userId)) {
        throw new NotFoundError("Ludo room not found");
      }
      const player = room.players.find((candidate) => candidate.userId === userId)!;
      if (player.status !== "MATCHED") {
        const prior = await tx.ludoAction.findFirst({
          where: { roomId: gameId, userId, type: "match.accept" },
          orderBy: { createdAt: "desc" },
        });
        if (prior) return { event: prior.serverEvent as unknown as LudoServerEvent, userIds: [] };
      }
      // Acceptance is a per-player handshake, not a board mutation. Clients
      // may accept concurrently from the same match-found version.
      if (room.status !== "MATCHED" && room.status !== "WAITING_READY") {
        throw new ConflictError("This match can no longer be accepted");
      }
      const now = await this.dbNow(tx);
      if (room.acceptanceDeadline && room.acceptanceDeadline <= now) {
        throw new ConflictError("The match acceptance window expired");
      }
      if (player.status === "MATCHED") {
        await tx.ludoPlayer.update({
          where: { id: player.id },
          data: { status: "ACCEPTED", acceptedAt: now },
        });
        await tx.ludoQueueEntry.updateMany({
          where: { userId, matchedRoomId: gameId },
          data: { acceptedAt: now },
        });
      }
      const acceptedCount =
        room.players.filter((candidate) => candidate.status !== "MATCHED").length +
        (player.status === "MATCHED" ? 1 : 0);
      const nextVersion = room.stateVersion + 1;
      const allAccepted = acceptedCount === room.players.length;
      const event = this.hub.event(
        allAccepted ? "room.created" : "room.player_joined",
        { userId, accepted: true, allAccepted },
        gameId,
        nextVersion,
      );
      await tx.ludoRoom.update({
        where: { id: gameId },
        data: {
          stateVersion: nextVersion,
          ...(allAccepted
            ? {
                status: "WAITING_READY",
                acceptanceDeadline: new Date(now.getTime() + config.matchAcceptanceSeconds * 1000),
              }
            : {}),
        },
      });
      await tx.ludoAction.create({
        data: {
          roomId: gameId,
          userId,
          actionId,
          type: "match.accept",
          stateVersion: nextVersion,
          payload: {},
          serverEvent: asJson(event),
        },
      });
      return { event, userIds: room.players.map((candidate) => candidate.userId) };
    });
    for (const id of result.userIds) this.hub.send(id, result.event);
    return result.event;
  }

  async readyRoom(
    userId: string,
    gameId: string,
    actionId: string,
    expectedStateVersion: number,
  ): Promise<LudoServerEvent> {
    const config = await this.assertAvailable();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `ludo:room:${gameId}`, 20260804);
      const duplicate = await tx.ludoAction.findUnique({
        where: { roomId_actionId: { roomId: gameId, actionId } },
      });
      if (duplicate)
        return { event: duplicate.serverEvent as unknown as LudoServerEvent, userIds: [] };
      const room = await tx.ludoRoom.findUnique({
        where: { id: gameId },
        include: { players: true },
      });
      if (!room || !room.players.some((player) => player.userId === userId)) {
        throw new NotFoundError("Ludo room not found");
      }
      const player = room.players.find((candidate) => candidate.userId === userId)!;
      if (player.status !== "ACCEPTED") {
        const prior = await tx.ludoAction.findFirst({
          where: { roomId: gameId, userId, type: "room.ready" },
          orderBy: { createdAt: "desc" },
        });
        if (prior) return { event: prior.serverEvent as unknown as LudoServerEvent, userIds: [] };
      }
      // Ready is likewise per-player and safe to serialize without rejecting
      // peers that pressed Ready from the same room-created version.
      if (room.status !== "WAITING_READY") throw new ConflictError("All players must accept first");
      const now = await this.dbNow(tx);
      if (room.acceptanceDeadline && room.acceptanceDeadline <= now) {
        throw new ConflictError("The ready window expired");
      }
      if (player.status !== "ACCEPTED" && player.status !== "READY") {
        throw new ConflictError("Accept the match before becoming ready");
      }
      if (player.status === "ACCEPTED") {
        await tx.ludoPlayer.update({
          where: { id: player.id },
          data: { status: "READY", readyAt: now },
        });
      }
      const readyCount =
        room.players.filter((candidate) => candidate.status === "READY").length +
        (player.status === "ACCEPTED" ? 1 : 0);
      const allReady = readyCount === room.players.length;
      const nextVersion = room.stateVersion + 1;
      let nextState = asState(room.state);
      if (allReady) nextState = startGame(nextState, now.toISOString());
      const nextTurnDeadline = new Date(now.getTime() + config.turnDurationSeconds * 1000);
      await tx.ludoRoom.update({
        where: { id: gameId },
        data: {
          state: asJson(nextState),
          stateVersion: nextVersion,
          ...(allReady
            ? {
                status: "ACTIVE",
                startedAt: now,
                turnDeadline: nextTurnDeadline,
                acceptanceDeadline: null,
              }
            : {}),
        },
      });
      if (allReady) {
        await tx.ludoPlayer.updateMany({
          where: { roomId: gameId },
          data: { status: "ACTIVE" },
        });
      }
      const event = this.hub.event(
        allReady ? "game.started" : "room.player_joined",
        allReady
          ? {
              snapshot: await this.snapshotFromData(
                tx,
                { ...room, status: "ACTIVE", turnDeadline: nextTurnDeadline },
                nextState,
                nextVersion,
                nextTurnDeadline,
              ),
            }
          : { userId, ready: true, allReady: false },
        gameId,
        nextVersion,
      );
      await tx.ludoAction.create({
        data: {
          roomId: gameId,
          userId,
          actionId,
          type: "room.ready",
          stateVersion: nextVersion,
          payload: {},
          serverEvent: asJson(event),
        },
      });
      return { event, userIds: room.players.map((candidate) => candidate.userId) };
    });
    for (const id of result.userIds) this.hub.send(id, result.event);
    return result.event;
  }

  private versionConflict(actual: number): never {
    throw new AppError("Game state changed; synchronize and retry", 409, "STATE_VERSION_MISMATCH", {
      actualStateVersion: actual,
    });
  }

  async getActive(userId: string): Promise<Record<string, unknown> | null> {
    const player = await this.prisma.ludoPlayer.findFirst({
      where: { activeKey: userId },
      select: { roomId: true },
    });
    return player ? this.getSnapshot(userId, player.roomId) : null;
  }

  async getSnapshot(userId: string, gameId: string): Promise<Record<string, unknown>> {
    const [viewerMutes, viewerBlocks] = await Promise.all([
      this.prisma.ludoUserMute.findMany({
        where: { roomId: gameId, userId },
        select: { mutedUserId: true },
      }),
      this.prisma.ludoUserBlock.findMany({
        where: { userId },
        select: { blockedUserId: true },
      }),
    ]);
    const hiddenUserIds = [
      ...new Set([
        ...viewerMutes.map((row) => row.mutedUserId),
        ...viewerBlocks.map((row) => row.blockedUserId),
      ]),
    ];
    const room = await this.prisma.ludoRoom.findUnique({
      where: { id: gameId },
      include: {
        players: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                avatarUrl: true,
                ludoEntitlement: {
                  select: { plan: true, status: true, startsAt: true, expiresAt: true },
                },
              },
            },
          },
        },
        chatMessages: {
          where: hiddenUserIds.length > 0 ? { userId: { notIn: hiddenUserIds } } : undefined,
          orderBy: { createdAt: "desc" },
          take: 50,
          include: { user: { select: { name: true } } },
        },
      },
    });
    if (!room || !room.players.some((player) => player.userId === userId)) {
      throw new NotFoundError("Ludo room not found");
    }
    return this.snapshot(room);
  }

  private snapshot(room: {
    id: string;
    mode: LudoGameMode;
    status: string;
    stateVersion: number;
    state: Prisma.JsonValue;
    turnDeadline: Date | null;
    players: SnapshotPlayerRow[];
    chatMessages: Array<{
      id: string;
      userId: string;
      type: string;
      content: string;
      createdAt: Date;
      user: { name: string };
    }>;
  }): Record<string, unknown> {
    const state = asState(room.state);
    const byUser = new Map(state.players.map((player) => [player.userId, player]));
    const currentTurnUserId = state.players.find(
      (player) => player.seat === state.currentTurnSeat,
    )?.userId;
    const isConnectedToRoom = (userId: string): boolean => {
      const session = this.hub.session(userId);
      return session?.gameId === room.id;
    };
    return {
      gameId: room.id,
      mode: room.mode,
      status: room.status,
      stateVersion: room.stateVersion,
      phase: state.phase,
      currentTurnUserId: currentTurnUserId ?? null,
      turnDeadline: room.turnDeadline?.toISOString() ?? null,
      turnDeadlineAt: room.turnDeadline?.toISOString() ?? null,
      turnNumber: state.turnNumber,
      dice: state.dice,
      legalPawnIds: state.legalPawnIds,
      players: room.players
        .sort((a, b) => a.seat - b.seat)
        .map((player) => ({
          userId: player.userId,
          displayName: player.user.name,
          avatarUrl: player.user.avatarUrl,
          color: player.color,
          seat: player.seat,
          pawns: (byUser.get(player.userId)?.pawns ?? []).map((progress, index) => ({
            index,
            progress,
          })),
          status: player.status,
          connected:
            (player.status === "ACTIVE" || player.status === "READY") &&
            isConnectedToRoom(player.userId),
          connectionState:
            player.status === "FORFEITED" || player.status === "FINISHED"
              ? player.status
              : isConnectedToRoom(player.userId)
                ? "CONNECTED"
                : player.status === "DISCONNECTED"
                  ? "RECONNECTING"
                  : "DISCONNECTED",
          plan: this.effectivePlan(player.user.ludoEntitlement),
          finishedPosition: byUser.get(player.userId)?.finishedPosition ?? player.finishedPosition,
        })),
      finishOrder: state.finishOrder,
      config: state.config,
      chat: [...room.chatMessages].reverse().map((message) => ({
        id: message.id,
        userId: message.userId,
        displayName: message.user.name,
        type: message.type,
        message: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
    };
  }

  private async snapshotFromData(
    tx: Prisma.TransactionClient,
    room: { id: string; mode: LudoGameMode; status: string; turnDeadline: Date | null },
    state: LudoEngineState,
    stateVersion: number,
    turnDeadline: Date | null,
  ): Promise<Record<string, unknown>> {
    const players = await tx.ludoPlayer.findMany({
      where: { roomId: room.id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            ludoEntitlement: {
              select: { plan: true, status: true, startsAt: true, expiresAt: true },
            },
          },
        },
      },
    });
    return this.snapshot({
      ...room,
      status:
        state.status === "COMPLETED"
          ? "COMPLETED"
          : state.status === "ACTIVE"
            ? "ACTIVE"
            : room.status,
      stateVersion,
      state: state as unknown as Prisma.JsonValue,
      turnDeadline: state.status === "ACTIVE" ? turnDeadline : room.turnDeadline,
      players,
      chatMessages: [],
    });
  }

  /** Compact authoritative board state for hot-path mutations. Profiles and
   * chat are intentionally omitted so clients merge them from the latest full
   * recovery snapshot instead of clearing chat or paying for per-action joins. */
  private compactSnapshot(
    room: { id: string; mode: LudoGameMode },
    state: LudoEngineState,
    stateVersion: number,
    turnDeadline: Date | null,
  ): Record<string, unknown> {
    const currentTurnUserId = state.players.find(
      (player) => player.seat === state.currentTurnSeat,
    )?.userId;
    return {
      gameId: room.id,
      mode: room.mode,
      status: state.status === "COMPLETED" ? "COMPLETED" : "ACTIVE",
      stateVersion,
      phase: state.phase,
      currentTurnUserId: currentTurnUserId ?? null,
      currentTurnSeat: state.currentTurnSeat,
      turnDeadline: turnDeadline?.toISOString() ?? null,
      turnDeadlineAt: turnDeadline?.toISOString() ?? null,
      turnNumber: state.turnNumber,
      dice: state.dice,
      legalPawnIds: state.legalPawnIds,
      players: state.players.map((player) => ({
        userId: player.userId,
        seat: player.seat,
        color: player.color,
        status: player.status,
        pawns: player.pawns.map((progress, index) => ({ index, progress })),
        finishedPosition: player.finishedPosition,
      })),
      finishOrder: state.finishOrder,
      config: state.config,
    };
  }

  async resumeActive(
    userId: string,
    resumeToken: string | undefined,
    lastAcknowledgedStateVersion: number,
  ): Promise<{ gameId: string; resumeToken: string; event: LudoServerEvent } | null> {
    const resumed = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `ludo:user:${userId}`, 20260805);
      const player = await tx.ludoPlayer.findFirst({
        where: { activeKey: userId },
        include: { room: true },
      });
      if (!player) return null;
      if (resumeToken && hashToken(resumeToken) !== player.resumeTokenHash) {
        throw new ForbiddenError("Invalid resume token");
      }
      const rotated = generateOpaqueToken();
      const changed = await tx.ludoPlayer.updateMany({
        where: { id: player.id, resumeTokenHash: player.resumeTokenHash },
        data: {
          resumeTokenHash: hashToken(rotated),
          lastAcknowledgedVersion: Math.min(lastAcknowledgedStateVersion, player.room.stateVersion),
          ...(player.status === "DISCONNECTED"
            ? {
                status: player.room.status === "ACTIVE" ? "ACTIVE" : "READY",
                disconnectedAt: null,
                reconnectDeadline: null,
              }
            : {}),
        },
      });
      if (changed.count !== 1)
        throw new ConflictError("Resume credential changed; reconnect again");
      return { player, rotated };
    });
    if (!resumed) return null;
    const { player, rotated } = resumed;
    this.hub.setGame(userId, player.roomId);

    // A full authoritative snapshot is deliberately used on reconnect. It is
    // bounded (four players + 50 chat messages) and restores every UI facet in
    // one event, while the append-only action log remains available for replay
    // tooling and future patch-based clients.
    const event = this.hub.event(
      "game.state",
      { snapshot: await this.getSnapshot(userId, player.roomId) },
      player.roomId,
      player.room.stateVersion,
    );
    this.hub.broadcastRoom(
      player.roomId,
      this.hub.event(
        "room.player_reconnected",
        { userId },
        player.roomId,
        player.room.stateVersion,
      ),
    );
    return { gameId: player.roomId, resumeToken: rotated, event };
  }

  async acknowledgeVersion(userId: string, gameId: string, version: number): Promise<void> {
    await this.prisma.ludoPlayer.updateMany({
      where: { roomId: gameId, userId, lastAcknowledgedVersion: { lt: version } },
      data: { lastAcknowledgedVersion: version },
    });
  }

  async getHistory(
    userId: string,
    query: LudoHistoryQuery,
  ): Promise<{ items: unknown[]; meta: PageMeta }> {
    const where: Prisma.LudoRoomWhereInput = {
      status: { in: ["COMPLETED", "CANCELLED", "ABANDONED", "EXPIRED"] },
      players: { some: { userId } },
    };
    const [rooms, total] = await Promise.all([
      this.prisma.ludoRoom.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          players: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } },
        },
      }),
      this.prisma.ludoRoom.count({ where }),
    ]);
    return {
      items: rooms.map((room) => {
        const mine = room.players.find((player) => player.userId === userId);
        return {
          gameId: room.id,
          mode: room.mode,
          status: room.status,
          result:
            room.status === "COMPLETED"
              ? mine?.finishedPosition === 1
                ? "WIN"
                : "LOSS"
              : room.status,
          position: mine?.finishedPosition ?? null,
          finishedPosition: mine?.finishedPosition ?? null,
          durationSeconds:
            room.startedAt && room.completedAt
              ? Math.max(
                  0,
                  Math.round((room.completedAt.getTime() - room.startedAt.getTime()) / 1000),
                )
              : null,
          captures: mine?.captures ?? 0,
          diceRolls: mine?.diceRolls ?? 0,
          pawnsCompleted: mine?.pawnsCompleted ?? 0,
          opponents: room.players
            .filter((player) => player.userId !== userId)
            .map((player) => ({
              userId: player.userId,
              displayName: player.user.name,
              avatarUrl: player.user.avatarUrl,
              finishedPosition: player.finishedPosition,
            })),
          startedAt: room.startedAt?.toISOString() ?? null,
          completedAt: room.completedAt?.toISOString() ?? room.updatedAt.toISOString(),
        };
      }),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  }

  async getStatistics(userId: string): Promise<Record<string, number>> {
    const stats = await this.prisma.ludoStatistics.findUnique({ where: { userId } });
    const totalMatches = stats?.totalMatches ?? 0;
    const wins = stats?.wins ?? 0;
    return {
      totalMatches,
      wins,
      losses: stats?.losses ?? 0,
      winPercentage: totalMatches === 0 ? 0 : Math.round((wins / totalMatches) * 10_000) / 100,
      twoPlayerMatches: stats?.twoPlayerMatches ?? 0,
      threePlayerMatches: stats?.threePlayerMatches ?? 0,
      fourPlayerMatches: stats?.fourPlayerMatches ?? 0,
      disconnects: stats?.disconnects ?? 0,
      forfeits: stats?.forfeits ?? 0,
      captures: stats?.captures ?? 0,
      diceRolls: stats?.diceRolls ?? 0,
      pawnsCompleted: stats?.pawnsCompleted ?? 0,
      averageMatchDurationSeconds:
        totalMatches === 0 ? 0 : Math.round((stats?.totalDurationSeconds ?? 0) / totalMatches),
    };
  }

  async rollDice(
    userId: string,
    gameId: string,
    actionId: string,
    expectedStateVersion: number,
  ): Promise<LudoServerEvent> {
    const dice = randomInt(1, 7);
    return this.mutateActiveRoom({
      userId,
      gameId,
      actionId,
      expectedStateVersion,
      actionType: "dice.roll.request",
      requireUnexpiredTurnDeadline: true,
      mutate: (state, now) => {
        let outcome;
        try {
          outcome = applyRoll(state, userId, dice, now.toISOString());
        } catch (error) {
          throw new BadRequestError(
            error instanceof Error ? error.message : "Invalid dice request",
          );
        }
        const currentTurnUserId = outcome.state.players.find(
          (player) => player.seat === outcome.state.currentTurnSeat,
        )?.userId;
        return {
          state: outcome.state,
          eventType: "dice.rolled" as const,
          payload: {
            userId,
            dice,
            legalPawnIds: outcome.legalPawnIds,
            thirdSixForfeit: outcome.thirdSixForfeit,
            turnChanged: outcome.turnChanged,
            currentTurnUserId: currentTurnUserId ?? null,
          },
          diceRollIncrement: 1,
          capturesIncrement: 0,
          pawnsCompleted: null,
          resetTurnTimeouts: true,
        };
      },
    });
  }

  async movePawn(
    userId: string,
    gameId: string,
    actionId: string,
    expectedStateVersion: number,
    pawnIndex: number,
  ): Promise<LudoServerEvent> {
    return this.mutateActiveRoom({
      userId,
      gameId,
      actionId,
      expectedStateVersion,
      actionType: "pawn.move.request",
      clientPayload: { pawnIndex },
      requireUnexpiredTurnDeadline: true,
      mutate: (state, now) => {
        let outcome;
        try {
          outcome = applyMove(state, userId, pawnIndex, now.toISOString());
        } catch (error) {
          throw new BadRequestError(error instanceof Error ? error.message : "Invalid pawn move");
        }
        const currentTurnUserId = outcome.state.players.find(
          (player) => player.seat === outcome.state.currentTurnSeat,
        )?.userId;
        const actor = outcome.state.players.find((player) => player.userId === userId)!;
        return {
          state: outcome.state,
          eventType:
            outcome.state.status === "COMPLETED"
              ? ("game.finished" as const)
              : ("pawn.moved" as const),
          payload: {
            userId,
            pawnIndex,
            from: outcome.from,
            to: outcome.to,
            toProgress: outcome.to,
            path: outcome.path,
            captured: outcome.captured,
            reachedHome: outcome.reachedHome,
            playerFinished: outcome.playerFinished,
            extraTurn: outcome.extraTurn,
            turnChanged: outcome.turnChanged,
            currentTurnUserId: currentTurnUserId ?? null,
            finishOrder: outcome.state.finishOrder,
          },
          diceRollIncrement: 0,
          capturesIncrement: outcome.captured.length,
          pawnsCompleted: completedPawnCount(actor),
          resetTurnTimeouts: true,
        };
      },
    });
  }

  private async mutateActiveRoom(params: {
    userId: string;
    gameId: string;
    actionId: string;
    expectedStateVersion: number;
    actionType: string;
    clientPayload?: Record<string, unknown>;
    mutate: (
      state: LudoEngineState,
      now: Date,
      membership: { turnTimeouts: number },
    ) => {
      state: LudoEngineState;
      eventType: LudoServerEventType;
      payload: Record<string, unknown>;
      diceRollIncrement: number;
      capturesIncrement: number;
      pawnsCompleted: number | null;
      resetTurnTimeouts?: boolean;
      timeoutStrikeIncrement?: boolean;
      forfeitedUserId?: string;
    };
    requireExpiredTurnDeadline?: boolean;
    requireUnexpiredTurnDeadline?: boolean;
  }): Promise<LudoServerEvent> {
    // Availability flags gate discovery and new queues only. Once a room is
    // ACTIVE it uses its persisted config snapshot and must not consult a
    // mutable master-disable or maintenance flag on the hot path.
    const result: RoomMutationResult = await this.prisma.$transaction(
      async (tx) => {
        await this.lock(tx, `ludo:room:${params.gameId}`, 20260804);
        const duplicate = await tx.ludoAction.findUnique({
          where: { roomId_actionId: { roomId: params.gameId, actionId: params.actionId } },
        });
        if (duplicate) {
          const userIds = await tx.ludoPlayer.findMany({
            where: { roomId: params.gameId },
            select: { userId: true },
          });
          return {
            event: duplicate.serverEvent as unknown as LudoServerEvent,
            userIds: userIds.map((player) => player.userId),
            completed: false,
            clearedUserIds: [],
          };
        }
        const room = await tx.ludoRoom.findUnique({
          where: { id: params.gameId },
          include: { players: true },
        });
        if (!room || !room.players.some((player) => player.userId === params.userId)) {
          throw new NotFoundError("Ludo room not found");
        }
        if (room.status !== "ACTIVE") throw new ConflictError("This Ludo match is not active");
        if (room.stateVersion !== params.expectedStateVersion)
          this.versionConflict(room.stateVersion);
        const membership = room.players.find((player) => player.userId === params.userId)!;
        if (membership.status !== "ACTIVE" && membership.status !== "DISCONNECTED") {
          throw new ForbiddenError("This player can no longer act in the match");
        }
        const now = await this.dbNow(tx);
        if (
          params.requireExpiredTurnDeadline &&
          (!room.turnDeadline || room.turnDeadline.getTime() > now.getTime())
        ) {
          throw new ConflictError("This turn has not expired");
        }
        if (
          params.requireUnexpiredTurnDeadline &&
          (!room.turnDeadline || room.turnDeadline.getTime() <= now.getTime())
        ) {
          throw new AppError(
            "The authoritative turn deadline has expired",
            409,
            "TURN_DEADLINE_EXPIRED",
            {
              turnDeadlineAt: room.turnDeadline?.toISOString() ?? null,
              serverTime: now.toISOString(),
            },
          );
        }
        const mutation = params.mutate(asState(room.state), now, membership);
        const nextVersion = room.stateVersion + 1;
        const completed = mutation.state.status === "COMPLETED";
        const frozenConfig = room.configSnapshot as unknown as Partial<LudoRuntimeConfig>;
        const turnDurationSeconds =
          typeof frozenConfig.turnDurationSeconds === "number" &&
          Number.isInteger(frozenConfig.turnDurationSeconds) &&
          frozenConfig.turnDurationSeconds > 0
            ? frozenConfig.turnDurationSeconds
            : 30;
        const nextTurnDeadline = completed
          ? null
          : new Date(now.getTime() + turnDurationSeconds * 1000);
        await tx.ludoRoom.update({
          where: { id: params.gameId },
          data: {
            state: asJson(mutation.state),
            stateVersion: nextVersion,
            turnDeadline: nextTurnDeadline,
            ...(completed ? { status: "COMPLETED", completedAt: now } : {}),
          },
        });
        if (
          mutation.diceRollIncrement > 0 ||
          mutation.capturesIncrement > 0 ||
          mutation.pawnsCompleted !== null ||
          mutation.resetTurnTimeouts ||
          mutation.timeoutStrikeIncrement ||
          mutation.forfeitedUserId
        ) {
          await tx.ludoPlayer.update({
            where: { id: membership.id },
            data: {
              ...(mutation.diceRollIncrement > 0
                ? { diceRolls: { increment: mutation.diceRollIncrement } }
                : {}),
              ...(mutation.capturesIncrement > 0
                ? { captures: { increment: mutation.capturesIncrement } }
                : {}),
              ...(mutation.pawnsCompleted !== null
                ? { pawnsCompleted: mutation.pawnsCompleted }
                : {}),
              ...(mutation.resetTurnTimeouts ? { turnTimeouts: 0 } : {}),
              ...(mutation.timeoutStrikeIncrement ? { turnTimeouts: { increment: 1 } } : {}),
              ...(mutation.forfeitedUserId === params.userId
                ? {
                    status: "FORFEITED",
                    activeKey: null,
                    reconnectDeadline: null,
                    disconnectedAt: null,
                  }
                : {}),
            },
          });
        }
        if (mutation.forfeitedUserId) {
          const voiceSession = await tx.ludoVoiceSession.findUnique({
            where: { roomId: params.gameId },
            select: { id: true },
          });
          if (voiceSession) {
            await tx.ludoVoiceParticipant.updateMany({
              where: {
                sessionId: voiceSession.id,
                userId: mutation.forfeitedUserId,
                leftAt: null,
              },
              data: { leftAt: now },
            });
          }
        }
        if (completed) await this.settleCompletedRoom(tx, room, mutation.state, now);

        const currentTurn = mutation.state.players.find(
          (player) => player.seat === mutation.state.currentTurnSeat,
        );
        const snapshot = this.compactSnapshot(room, mutation.state, nextVersion, nextTurnDeadline);
        const event = this.hub.event(
          mutation.eventType,
          {
            ...mutation.payload,
            phase: mutation.state.phase,
            status: completed ? "COMPLETED" : "ACTIVE",
            currentTurnUserId: currentTurn?.userId ?? null,
            currentTurnSeat: mutation.state.currentTurnSeat,
            turnDeadlineAt: nextTurnDeadline?.toISOString() ?? null,
            dice: mutation.state.dice,
            legalPawnIds: mutation.state.legalPawnIds,
            finishOrder: mutation.state.finishOrder,
            snapshot,
          },
          params.gameId,
          nextVersion,
        );
        await tx.ludoAction.create({
          data: {
            roomId: params.gameId,
            userId: params.userId,
            actionId: params.actionId,
            type: params.actionType,
            stateVersion: nextVersion,
            payload: asJson(params.clientPayload ?? {}),
            serverEvent: asJson(event),
          },
        });
        return {
          event,
          userIds: room.players.map((player) => player.userId),
          completed,
          clearedUserIds: mutation.forfeitedUserId ? [mutation.forfeitedUserId] : [],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 },
    );

    for (const userId of result.userIds) {
      this.hub.send(userId, result.event);
      if (result.completed || result.clearedUserIds.includes(userId))
        this.hub.setGame(userId, null);
    }
    if (result.completed) {
      const winnerId = (result.event.payload as { finishOrder?: string[] }).finishOrder?.[0];
      if (winnerId) {
        void this.notifications.enqueue({
          userId: winnerId,
          type: "SYSTEM",
          title: "Ludo victory!",
          body: "You finished first in your Ludo match.",
          route: "/ludo/history",
        });
      }
    }
    return result.event;
  }

  async forfeit(
    userId: string,
    gameId: string,
    actionId: string,
    expectedStateVersion: number,
    reason = "PLAYER_LEFT",
  ): Promise<LudoServerEvent> {
    return this.mutateActiveRoom({
      userId,
      gameId,
      actionId,
      expectedStateVersion,
      actionType: "room.leave",
      clientPayload: { reason },
      mutate: (state, now) => {
        let next;
        try {
          next = forfeitPlayer(state, userId, now.toISOString());
        } catch (error) {
          throw new BadRequestError(
            error instanceof Error ? error.message : "Player cannot forfeit",
          );
        }
        return {
          state: next,
          eventType:
            next.status === "COMPLETED" ? ("game.finished" as const) : ("game.forfeited" as const),
          payload: { userId, reason, finishOrder: next.finishOrder },
          diceRollIncrement: 0,
          capturesIncrement: 0,
          pawnsCompleted: null,
          forfeitedUserId: userId,
        };
      },
    });
  }

  private async settleCompletedRoom(
    tx: Prisma.TransactionClient,
    room: { id: string; mode: LudoGameMode; startedAt: Date | null },
    state: LudoEngineState,
    now: Date,
  ): Promise<void> {
    const players = await tx.ludoPlayer.findMany({ where: { roomId: room.id } });
    const durationSeconds = room.startedAt
      ? Math.max(0, Math.round((now.getTime() - room.startedAt.getTime()) / 1000))
      : 0;
    for (const player of players) {
      const enginePlayer = state.players.find((candidate) => candidate.userId === player.userId)!;
      const position = state.finishOrder.indexOf(player.userId) + 1;
      const forfeited = enginePlayer.status === "FORFEITED";
      await tx.ludoPlayer.update({
        where: { id: player.id },
        data: {
          activeKey: null,
          status: forfeited ? "FORFEITED" : "FINISHED",
          finishedPosition: position > 0 ? position : null,
          reconnectDeadline: null,
        },
      });
      await tx.ludoStatistics.upsert({
        where: { userId: player.userId },
        create: {
          userId: player.userId,
          totalMatches: 1,
          wins: position === 1 ? 1 : 0,
          losses: position === 1 ? 0 : 1,
          twoPlayerMatches: room.mode === "TWO_PLAYER" ? 1 : 0,
          threePlayerMatches: room.mode === "THREE_PLAYER" ? 1 : 0,
          fourPlayerMatches: room.mode === "FOUR_PLAYER" ? 1 : 0,
          disconnects: player.disconnectCount,
          forfeits: forfeited ? 1 : 0,
          captures: player.captures,
          diceRolls: player.diceRolls,
          pawnsCompleted: completedPawnCount(enginePlayer),
          totalDurationSeconds: durationSeconds,
        },
        update: {
          totalMatches: { increment: 1 },
          wins: { increment: position === 1 ? 1 : 0 },
          losses: { increment: position === 1 ? 0 : 1 },
          twoPlayerMatches: { increment: room.mode === "TWO_PLAYER" ? 1 : 0 },
          threePlayerMatches: { increment: room.mode === "THREE_PLAYER" ? 1 : 0 },
          fourPlayerMatches: { increment: room.mode === "FOUR_PLAYER" ? 1 : 0 },
          disconnects: { increment: player.disconnectCount },
          forfeits: { increment: forfeited ? 1 : 0 },
          captures: { increment: player.captures },
          diceRolls: { increment: player.diceRolls },
          pawnsCompleted: { increment: completedPawnCount(enginePlayer) },
          totalDurationSeconds: { increment: durationSeconds },
        },
      });
    }
    await tx.ludoVoiceSession.updateMany({
      where: { roomId: room.id, endedAt: null },
      data: { endedAt: now },
    });
  }

  async markDisconnected(userId: string): Promise<void> {
    await this.leaveMatchmaking(userId).catch(() => undefined);
    const player = await this.prisma.ludoPlayer.findFirst({
      where: { activeKey: userId },
      include: { room: true },
    });
    if (!player) return;
    if (player.room.status !== "ACTIVE") {
      await this.cancelPreGameRoom(player.roomId, "PLAYER_DISCONNECTED");
      return;
    }
    const config = await this.runtimeConfig();
    const now = new Date();
    const changed = await this.prisma.ludoPlayer.updateMany({
      where: { id: player.id, status: "ACTIVE" },
      data: {
        status: "DISCONNECTED",
        disconnectedAt: now,
        reconnectDeadline: new Date(now.getTime() + config.reconnectionGraceSeconds * 1000),
        disconnectCount: { increment: 1 },
      },
    });
    if (changed.count > 0) {
      this.hub.broadcastRoom(
        player.roomId,
        this.hub.event(
          "room.player_disconnected",
          {
            userId,
            reconnectDeadline: new Date(
              now.getTime() + config.reconnectionGraceSeconds * 1000,
            ).toISOString(),
          },
          player.roomId,
          player.room.stateVersion,
        ),
      );
    }
  }

  private async assertRoomMember(userId: string, gameId: string): Promise<void> {
    const player = await this.prisma.ludoPlayer.findUnique({
      where: { roomId_userId: { roomId: gameId, userId } },
      include: { room: { select: { status: true } } },
    });
    if (!player || player.room.status !== "ACTIVE" || player.status !== "ACTIVE") {
      throw new ForbiddenError("You are not an active member of this room");
    }
  }

  private async enforceChatRate(userId: string, gameId: string, limit: number): Promise<void> {
    const count = await this.prisma.ludoChatMessage.count({
      where: {
        userId,
        roomId: gameId,
        createdAt: { gte: new Date(Date.now() - 10_000) },
      },
    });
    if (count >= limit) throw new AppError("Please slow down", 429, "CHAT_RATE_LIMITED");
  }

  private async chatExclusions(gameId: string, senderId: string): Promise<string[]> {
    const [mutes, blocks] = await Promise.all([
      this.prisma.ludoUserMute.findMany({
        where: { roomId: gameId, mutedUserId: senderId },
        select: { userId: true },
      }),
      this.prisma.ludoUserBlock.findMany({
        where: { blockedUserId: senderId },
        select: { userId: true },
      }),
    ]);
    return [...new Set([...mutes.map((row) => row.userId), ...blocks.map((row) => row.userId)])];
  }

  private async existingChatEvent(
    userId: string,
    gameId: string,
    actionId: string,
  ): Promise<LudoServerEvent | null> {
    const row = await this.prisma.ludoChatMessage.findUnique({
      where: { roomId_userId_clientActionId: { roomId: gameId, userId, clientActionId: actionId } },
      include: { room: { select: { stateVersion: true } } },
    });
    if (!row) return null;
    return {
      type: row.type === "TEXT" ? "chat.text.received" : "chat.quick.received",
      eventId: row.id,
      gameId,
      stateVersion: row.room.stateVersion,
      serverTimestamp: row.createdAt.toISOString(),
      payload: {
        id: row.id,
        userId,
        message: row.content,
        createdAt: row.createdAt.toISOString(),
      },
    };
  }

  private chatEvent(
    row: { id: string; userId: string; content: string; createdAt: Date },
    type: "chat.quick.received" | "chat.text.received",
    gameId: string,
    stateVersion: number,
  ): LudoServerEvent {
    return {
      type,
      eventId: row.id,
      gameId,
      stateVersion,
      serverTimestamp: row.createdAt.toISOString(),
      payload: {
        id: row.id,
        userId: row.userId,
        message: row.content,
        createdAt: row.createdAt.toISOString(),
      },
    };
  }

  async sendQuickChat(
    userId: string,
    gameId: string,
    actionId: string,
    message: string,
  ): Promise<LudoServerEvent> {
    const prior = await this.existingChatEvent(userId, gameId, actionId);
    if (prior) return prior;
    const config = await this.runtimeConfig();
    await this.assertRoomMember(userId, gameId);
    await this.assertNotRestricted(userId, "COMMUNICATION");
    const code = message.trim().toUpperCase();
    if (![...config.quickMessages, ...config.freeReactions].includes(code)) {
      throw new BadRequestError("This quick message is not available");
    }
    await this.enforceChatRate(userId, gameId, config.chatRateLimitPer10Seconds);
    let created = true;
    let row;
    try {
      row = await this.prisma.ludoChatMessage.create({
        data: { roomId: gameId, userId, clientActionId: actionId, type: "QUICK", content: code },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
        throw error;
      created = false;
      row = await this.prisma.ludoChatMessage.findUniqueOrThrow({
        where: {
          roomId_userId_clientActionId: { roomId: gameId, userId, clientActionId: actionId },
        },
      });
    }
    const room = await this.prisma.ludoRoom.findUniqueOrThrow({ where: { id: gameId } });
    const event = this.chatEvent(row, "chat.quick.received", gameId, room.stateVersion);
    if (created) {
      this.hub.broadcastRoom(gameId, event, {
        excludeUserIds: await this.chatExclusions(gameId, userId),
      });
    }
    return event;
  }

  async sendTextChat(
    userId: string,
    gameId: string,
    actionId: string,
    input: string,
  ): Promise<LudoServerEvent> {
    const prior = await this.existingChatEvent(userId, gameId, actionId);
    if (prior) return prior;
    const [config, entitlement] = await Promise.all([
      this.runtimeConfig(),
      this.effectiveEntitlement(userId),
    ]);
    if (!config.textChatEnabled) throw new ForbiddenError("Text chat is disabled");
    if (!entitlement.entitlements.textChat)
      throw new ForbiddenError("Ludo Plus or Pro is required");
    await this.assertRoomMember(userId, gameId);
    await this.assertNotRestricted(userId, "COMMUNICATION");
    await this.assertNotRestricted(userId, "TEXT_CHAT");
    await this.enforceChatRate(userId, gameId, config.chatRateLimitPer10Seconds);
    const message = this.sanitizeChat(input, config.chatMaxCharacters);
    const duplicateText = await this.prisma.ludoChatMessage.findFirst({
      where: {
        roomId: gameId,
        userId,
        type: "TEXT",
        content: message,
        createdAt: { gte: new Date(Date.now() - 15_000) },
      },
    });
    if (duplicateText) {
      const racedPrior = await this.existingChatEvent(userId, gameId, actionId);
      if (racedPrior) return racedPrior;
      throw new ConflictError("Duplicate chat message");
    }
    let created = true;
    let row;
    try {
      row = await this.prisma.ludoChatMessage.create({
        data: { roomId: gameId, userId, clientActionId: actionId, type: "TEXT", content: message },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002")
        throw error;
      created = false;
      row = await this.prisma.ludoChatMessage.findUniqueOrThrow({
        where: {
          roomId_userId_clientActionId: { roomId: gameId, userId, clientActionId: actionId },
        },
      });
    }
    const room = await this.prisma.ludoRoom.findUniqueOrThrow({ where: { id: gameId } });
    const event = this.chatEvent(row, "chat.text.received", gameId, room.stateVersion);
    if (created) {
      this.hub.broadcastRoom(gameId, event, {
        excludeUserIds: await this.chatExclusions(gameId, userId),
      });
    }
    return event;
  }

  private sanitizeChat(input: string, maxCharacters: number): string {
    const normalized = input
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) throw new BadRequestError("Message is empty");
    if ([...normalized].length > maxCharacters) {
      throw new BadRequestError(`Message must be at most ${maxCharacters} characters`);
    }
    if (/\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|in)\b)/i.test(normalized)) {
      throw new BadRequestError("Links are not allowed in match chat");
    }
    const abusive = /\b(?:fuck|bitch|cunt|madarchod|bhenchod)\b/gi;
    return normalized.replace(abusive, "••••");
  }

  async publishTyping(userId: string, gameId: string, typing: boolean): Promise<void> {
    const [config, entitlement] = await Promise.all([
      this.runtimeConfig(),
      this.effectiveEntitlement(userId),
    ]);
    if (!config.textChatEnabled || !entitlement.entitlements.textChat) return;
    await this.assertRoomMember(userId, gameId);
    const key = `${gameId}:${userId}`;
    const now = Date.now();
    const previous = this.typingActivity.get(key);
    if (previous && previous.typing === typing && now - previous.sentAt < 2_000) return;
    if (previous && now - previous.sentAt < 500) return;
    this.typingActivity.set(key, { typing, sentAt: now });
    if (this.typingActivity.size > 10_000) {
      const oldestKey = this.typingActivity.keys().next().value as string | undefined;
      if (oldestKey) this.typingActivity.delete(oldestKey);
    }
    this.hub.broadcastRoom(
      gameId,
      this.hub.event("chat.typing", { userId, typing }, gameId, null),
      { excludeUserIds: [userId] },
    );
  }

  async joinVoice(userId: string, gameId: string): Promise<LudoServerEvent> {
    const [config, entitlement] = await Promise.all([
      this.runtimeConfig(),
      this.effectiveEntitlement(userId),
    ]);
    if (!config.voiceEnabled) throw new ForbiddenError("Voice chat is disabled");
    if (!entitlement.entitlements.voiceChat) throw new ForbiddenError("Ludo Pro is required");
    await this.assertRoomMember(userId, gameId);
    await this.assertNotRestricted(userId, "COMMUNICATION");
    await this.assertNotRestricted(userId, "VOICE_CHAT");
    const session = await this.prisma.ludoVoiceSession.upsert({
      where: { roomId: gameId },
      create: { roomId: gameId },
      update: { endedAt: null },
    });
    await this.prisma.ludoVoiceParticipant.upsert({
      where: { sessionId_userId: { sessionId: session.id, userId } },
      create: { sessionId: session.id, userId },
      update: { joinedAt: new Date(), leftAt: null },
    });
    const [room, participants] = await Promise.all([
      this.prisma.ludoRoom.findUniqueOrThrow({ where: { id: gameId } }),
      this.prisma.ludoVoiceParticipant.findMany({
        where: { sessionId: session.id, leftAt: null },
        select: { userId: true, joinedAt: true },
        orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
      }),
    ]);
    const participantIds = participants.map((participant) => participant.userId).sort();
    const event = this.hub.event(
      "voice.participant_updated",
      {
        userId,
        joined: true,
        participants: participantIds,
        offerInitiatorUserId: userId,
        offerTargetUserIds: participantIds.filter((participantId) => participantId !== userId),
      },
      gameId,
      room.stateVersion,
    );
    this.hub.broadcastRoom(gameId, event);
    return event;
  }

  async leaveVoice(userId: string, gameId: string): Promise<LudoServerEvent> {
    await this.assertRoomMember(userId, gameId);
    const session = await this.prisma.ludoVoiceSession.findUnique({
      where: { roomId: gameId },
      select: { id: true, endedAt: true },
    });
    if (!session || session.endedAt) throw new ConflictError("No active voice session exists");
    await this.prisma.ludoVoiceParticipant.updateMany({
      where: { sessionId: session.id, userId, leftAt: null },
      data: { leftAt: new Date() },
    });
    const [room, participants] = await Promise.all([
      this.prisma.ludoRoom.findUniqueOrThrow({ where: { id: gameId } }),
      this.prisma.ludoVoiceParticipant.findMany({
        where: { sessionId: session.id, leftAt: null },
        select: { userId: true },
        orderBy: { userId: "asc" },
      }),
    ]);
    const event = this.hub.event(
      "voice.participant_updated",
      {
        userId,
        joined: false,
        participants: participants.map((participant) => participant.userId),
      },
      gameId,
      room.stateVersion,
    );
    this.hub.broadcastRoom(gameId, event);
    return event;
  }

  async relayVoice(
    userId: string,
    gameId: string,
    type: "voice.offer" | "voice.answer" | "voice.ice_candidate",
    payload: Record<string, unknown> & { targetUserId: string },
  ): Promise<LudoServerEvent> {
    if (userId === payload.targetUserId) throw new BadRequestError("Voice messages require a peer");
    const [config, sender, target] = await Promise.all([
      this.runtimeConfig(),
      this.effectiveEntitlement(userId),
      this.effectiveEntitlement(payload.targetUserId),
    ]);
    if (!config.voiceEnabled) throw new ForbiddenError("Voice chat is disabled");
    if (!sender.entitlements.voiceChat || !target.entitlements.voiceChat) {
      throw new ForbiddenError("Both voice participants require Ludo Pro");
    }
    await Promise.all([
      this.assertRoomMember(userId, gameId),
      this.assertRoomMember(payload.targetUserId, gameId),
      this.assertNotRestricted(userId, "COMMUNICATION"),
      this.assertNotRestricted(payload.targetUserId, "COMMUNICATION"),
      this.assertNotRestricted(userId, "VOICE_CHAT"),
      this.assertNotRestricted(payload.targetUserId, "VOICE_CHAT"),
    ]);
    const session = await this.prisma.ludoVoiceSession.findUnique({
      where: { roomId: gameId },
      include: {
        participants: {
          where: { userId: { in: [userId, payload.targetUserId] }, leftAt: null },
          select: { userId: true },
        },
      },
    });
    if (
      !session ||
      session.endedAt ||
      !session.participants.some((participant) => participant.userId === userId) ||
      !session.participants.some((participant) => participant.userId === payload.targetUserId)
    ) {
      throw new ConflictError("Both peers must join the active voice session first");
    }
    const room = await this.prisma.ludoRoom.findUniqueOrThrow({ where: { id: gameId } });
    const event = this.hub.event(
      type,
      { ...payload, fromUserId: userId },
      gameId,
      room.stateVersion,
    );
    if (!this.hub.send(payload.targetUserId, event)) {
      throw new ConflictError("Voice participant is offline");
    }
    return event;
  }

  async reportPlayer(
    reporterId: string,
    gameId: string,
    input: { targetUserId: string; category: string; details?: string; messageId?: string },
  ): Promise<LudoServerEvent> {
    await Promise.all([
      this.assertRoomMember(reporterId, gameId),
      this.assertRoomMember(input.targetUserId, gameId),
    ]);
    if (reporterId === input.targetUserId) throw new BadRequestError("You cannot report yourself");
    const report = await this.prisma.ludoReport.create({
      data: { roomId: gameId, reporterId, ...input },
    });
    return this.hub.event(
      "game.state",
      { reportSubmitted: true, reportId: report.id },
      gameId,
      null,
    );
  }

  async setBlock(userId: string, targetUserId: string, blocked: boolean): Promise<void> {
    if (userId === targetUserId) throw new BadRequestError("You cannot block yourself");
    if (blocked) {
      await this.prisma.ludoUserBlock.upsert({
        where: { userId_blockedUserId: { userId, blockedUserId: targetUserId } },
        create: { userId, blockedUserId: targetUserId },
        update: {},
      });
    } else {
      await this.prisma.ludoUserBlock.deleteMany({
        where: { userId, blockedUserId: targetUserId },
      });
    }
  }

  async setMute(
    userId: string,
    gameId: string,
    targetUserId: string,
    muted: boolean,
  ): Promise<void> {
    await this.assertRoomMember(userId, gameId);
    if (userId === targetUserId) throw new BadRequestError("You cannot mute yourself");
    if (muted) {
      await this.prisma.ludoUserMute.upsert({
        where: { roomId_userId_mutedUserId: { roomId: gameId, userId, mutedUserId: targetUserId } },
        create: { roomId: gameId, userId, mutedUserId: targetUserId },
        update: {},
      });
    } else {
      await this.prisma.ludoUserMute.deleteMany({
        where: { roomId: gameId, userId, mutedUserId: targetUserId },
      });
    }
  }

  private async cancelPreGameRoom(roomId: string, reason: string): Promise<void> {
    const config = await this.runtimeConfig();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `ludo:room:${roomId}`, 20260804);
      const room = await tx.ludoRoom.findUnique({
        where: { id: roomId },
        include: { players: true },
      });
      if (!room || (room.status !== "MATCHED" && room.status !== "WAITING_READY")) return null;
      const now = await this.dbNow(tx);
      await tx.ludoRoom.update({
        where: { id: roomId },
        data: {
          status: "CANCELLED",
          completedAt: now,
          cancelledReason: reason,
          acceptanceDeadline: null,
        },
      });
      await tx.ludoPlayer.updateMany({
        where: { roomId },
        data: { status: "FORFEITED", activeKey: null, reconnectDeadline: null },
      });
      const requeueResults: Array<{ userId: string; requeued: boolean; mode: LudoGameMode }> = [];
      for (const player of room.players) {
        const canRequeue = this.hub.session(player.userId) !== undefined;
        await tx.ludoQueueEntry.updateMany({
          where: { userId: player.userId, matchedRoomId: roomId },
          data: canRequeue
            ? {
                status: "QUEUED",
                matchedRoomId: null,
                acceptedAt: null,
                joinedAt: now,
                expiresAt: new Date(now.getTime() + config.queueTimeoutSeconds * 1000),
              }
            : { status: "TIMED_OUT", matchedRoomId: null },
        });
        requeueResults.push({ userId: player.userId, requeued: canRequeue, mode: room.mode });
      }
      return requeueResults;
    });
    if (!result) return;
    for (const player of result) {
      this.hub.setGame(player.userId, null);
      this.hub.send(
        player.userId,
        this.hub.event(
          "match.cancelled",
          { reason, requeued: player.requeued, mode: player.mode },
          roomId,
          null,
        ),
      );
    }
  }

  async sweep(): Promise<void> {
    const now = new Date();
    const expiredQueue = await this.prisma.ludoQueueEntry.findMany({
      where: { status: "QUEUED", expiresAt: { lte: now } },
      select: { id: true, userId: true },
      take: 200,
    });
    if (expiredQueue.length > 0) {
      await this.prisma.ludoQueueEntry.updateMany({
        where: { id: { in: expiredQueue.map((entry) => entry.id) }, status: "QUEUED" },
        data: { status: "TIMED_OUT" },
      });
      for (const entry of expiredQueue) {
        this.hub.send(entry.userId, this.hub.event("matchmaking.left", { status: "TIMED_OUT" }));
      }
    }

    const expiredPregame = await this.prisma.ludoRoom.findMany({
      where: {
        status: { in: ["MATCHED", "WAITING_READY"] },
        acceptanceDeadline: { lte: now },
      },
      select: { id: true },
      take: 100,
    });
    for (const room of expiredPregame) await this.cancelPreGameRoom(room.id, "ACCEPTANCE_TIMEOUT");

    const disconnected = await this.prisma.ludoPlayer.findMany({
      where: { status: "DISCONNECTED", reconnectDeadline: { lte: now }, activeKey: { not: null } },
      include: { room: { select: { stateVersion: true, status: true } } },
      take: 100,
    });
    for (const player of disconnected) {
      if (player.room.status !== "ACTIVE") continue;
      await this.forfeit(
        player.userId,
        player.roomId,
        `server:reconnect:${randomUUID()}`,
        player.room.stateVersion,
        "RECONNECT_TIMEOUT",
      ).catch(() => undefined);
    }

    const config = await this.runtimeConfig();

    // Retry pairing for queued modes. Matching used to run ONLY at the moment
    // a player joined the queue — if the other candidate's socket was
    // registering or reconnecting at that instant, the attempt failed and was
    // never retried, leaving everyone "finding players" until queue timeout.
    // This sweep (every 3s) makes pairing eventually consistent and fast.
    const queuedByMode = await this.prisma.ludoQueueEntry.groupBy({
      by: ["mode"],
      where: { status: "QUEUED", expiresAt: { gt: now } },
      _count: { mode: true },
    });
    for (const group of queuedByMode) {
      if (group._count.mode < roomPlayerCount(group.mode)) continue;
      // A full sweep may seat several rooms (e.g. 4 queued in 2-player mode).
      for (let round = 0; round < 5; round++) {
        const match = await this.tryCreateMatch(group.mode, config).catch(() => null);
        if (!match) break;
        this.publishMatchFound(match);
      }
    }

    const timedOutRooms = await this.prisma.ludoRoom.findMany({
      where: { status: "ACTIVE", turnDeadline: { lte: now } },
      take: 100,
    });
    for (const room of timedOutRooms) {
      const state = asState(room.state);
      const current = state.players.find((player) => player.seat === state.currentTurnSeat);
      if (!current) continue;
      const membership = await this.prisma.ludoPlayer.findUnique({
        where: { roomId_userId: { roomId: room.id, userId: current.userId } },
      });
      if (!membership) continue;
      await this.mutateActiveRoom({
        userId: current.userId,
        gameId: room.id,
        actionId: `server:turn:${randomUUID()}`,
        expectedStateVersion: room.stateVersion,
        actionType: "turn.timeout",
        requireExpiredTurnDeadline: true,
        mutate: (currentState, tick, lockedMembership) => {
          const strikes = lockedMembership.turnTimeouts + 1;
          if (strikes >= config.inactiveForfeitTurns) {
            const next = forfeitPlayer(currentState, current.userId, tick.toISOString());
            return {
              state: next,
              eventType:
                next.status === "COMPLETED"
                  ? ("game.finished" as const)
                  : ("game.forfeited" as const),
              payload: { reason: "TURN_TIMEOUT", userId: current.userId, strikes },
              diceRollIncrement: 0,
              capturesIncrement: 0,
              pawnsCompleted: null,
              timeoutStrikeIncrement: true,
              forfeitedUserId: current.userId,
            };
          }
          return {
            state: expireTurn(currentState, tick.toISOString()),
            eventType: "turn.changed" as const,
            payload: { reason: "TURN_TIMEOUT", userId: current.userId, strikes },
            diceRollIncrement: 0,
            capturesIncrement: 0,
            pawnsCompleted: null,
            timeoutStrikeIncrement: true,
          };
        },
      }).catch(() => undefined);
    }
  }

  startSweeper(): () => void {
    let running = false;
    const run = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        await this.sweep();
      } finally {
        running = false;
      }
    };
    void run();
    const timer = setInterval(() => void run(), 3_000);
    timer.unref();
    return () => clearInterval(timer);
  }
}
