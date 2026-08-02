import { z } from "zod";

export const ludoModeSchema = z.enum(["TWO_PLAYER", "THREE_PLAYER", "FOUR_PLAYER"]);
export type LudoModeInput = z.infer<typeof ludoModeSchema>;

export const ludoPlanSchema = z.enum(["FREE", "PLUS", "PRO"]);
export type LudoPlanCode = z.infer<typeof ludoPlanSchema>;

const actionIdSchema = z.string().min(8).max(128);
const clientTimestampSchema = z.union([
  z.number().int().nonnegative(),
  z.string().datetime({ offset: true }),
]);

const eventBase = {
  actionId: actionIdSchema,
  gameId: z.string().uuid().nullable().optional(),
  expectedStateVersion: z.number().int().nonnegative().nullable().optional(),
  timestamp: clientTimestampSchema,
};

const event = <TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payload: TPayload,
) => z.object({ type: z.literal(type), ...eventBase, payload });

export const socketAuthenticateEventSchema = z.object({
  type: z.literal("socket.authenticate"),
  actionId: actionIdSchema.optional(),
  gameId: z.string().uuid().nullable().optional(),
  expectedStateVersion: z.number().int().nonnegative().nullable().optional(),
  timestamp: clientTimestampSchema,
  payload: z.object({
    accessToken: z.string().min(16).max(8192),
    resumeToken: z.string().min(32).max(256).optional(),
    lastAcknowledgedStateVersion: z.number().int().nonnegative().default(0),
  }),
});

export const matchmakingJoinEventSchema = event(
  "matchmaking.join",
  z.object({
    mode: ludoModeSchema,
    region: z.string().trim().min(1).max(32).optional(),
    pingMs: z.number().int().min(0).max(60_000).optional(),
  }),
);
export const matchmakingLeaveEventSchema = event("matchmaking.leave", z.object({}));
export const matchAcceptEventSchema = event("match.accept", z.object({}));
export const roomReadyEventSchema = event("room.ready", z.object({}));
export const gameStateRequestEventSchema = z.object({
  type: z.literal("game.state.request"),
  actionId: actionIdSchema.optional(),
  gameId: z.string().uuid(),
  expectedStateVersion: z.number().int().nonnegative().nullable().optional(),
  timestamp: clientTimestampSchema,
  payload: z.object({ lastAcknowledgedStateVersion: z.number().int().nonnegative().default(0) }),
});
export const diceRollEventSchema = event("dice.roll.request", z.object({}));
export const pawnMoveEventSchema = event(
  "pawn.move.request",
  z.object({ pawnIndex: z.number().int().min(0).max(3) }),
);
export const quickChatEventSchema = event(
  "chat.quick.send",
  z.object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Z0-9_]+$/),
  }),
);
export const textChatEventSchema = event(
  "chat.text.send",
  z.object({ message: z.string().min(1).max(400) }),
);
export const typingStartEventSchema = event("typing.start", z.object({}));
export const typingStopEventSchema = event("typing.stop", z.object({}));
export const voiceJoinEventSchema = event("voice.session.join", z.object({}));
export const voiceLeaveEventSchema = event("voice.session.leave", z.object({}));
export const voiceOfferEventSchema = event(
  "voice.offer",
  z.object({ targetUserId: z.string().uuid(), sdp: z.string().min(1).max(32_768) }),
);
export const voiceAnswerEventSchema = event(
  "voice.answer",
  z.object({ targetUserId: z.string().uuid(), sdp: z.string().min(1).max(32_768) }),
);
export const voiceIceEventSchema = event(
  "voice.ice_candidate",
  z.object({
    targetUserId: z.string().uuid(),
    candidate: z.string().min(1).max(8192),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(1024).nullable().optional(),
  }),
);
export const playerReportEventSchema = event(
  "player.report",
  z.object({
    targetUserId: z.string().uuid(),
    category: z.enum(["ABUSE", "SPAM", "CHEATING", "VOICE", "OTHER"]),
    details: z.string().trim().max(500).optional(),
    messageId: z.string().uuid().optional(),
  }),
);
export const playerBlockEventSchema = event(
  "player.block",
  z.object({ targetUserId: z.string().uuid(), blocked: z.boolean().default(true) }),
);
export const playerMuteEventSchema = event(
  "player.mute",
  z.object({ targetUserId: z.string().uuid(), muted: z.boolean().default(true) }),
);
export const roomLeaveEventSchema = event(
  "room.leave",
  z.object({ reason: z.string().trim().max(200).optional() }),
);
export const socketPingEventSchema = z.object({
  type: z.literal("socket.ping"),
  actionId: actionIdSchema.optional(),
  gameId: z.string().uuid().nullable().optional(),
  expectedStateVersion: z.number().int().nonnegative().nullable().optional(),
  timestamp: clientTimestampSchema,
  payload: z.object({ clientTimestamp: clientTimestampSchema.optional() }),
});

export const tttMatchmakingJoinEventSchema = event("ttt.matchmaking.join", z.object({}));
export const tttMatchmakingLeaveEventSchema = event("ttt.matchmaking.leave", z.object({}));
export const tttStateRequestEventSchema = event("ttt.state.request", z.object({}));
export const tttMoveEventSchema = event(
  "ttt.move",
  z.object({ cell: z.number().int().min(0).max(8) }),
);
export const tttMatchLeaveEventSchema = event("ttt.match.leave", z.object({}));
export const tttQuickChatEventSchema = event(
  "ttt.chat.quick.send",
  z.object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Z0-9_]+$/),
  }),
);
export const tttTextChatEventSchema = event(
  "ttt.chat.text.send",
  z.object({ message: z.string().trim().min(1).max(160) }),
);
export const tttVoiceJoinEventSchema = event("ttt.voice.session.join", z.object({}));
export const tttVoiceLeaveEventSchema = event("ttt.voice.session.leave", z.object({}));
export const tttVoiceOfferEventSchema = event(
  "ttt.voice.offer",
  voiceOfferEventSchema.shape.payload,
);
export const tttVoiceAnswerEventSchema = event(
  "ttt.voice.answer",
  voiceAnswerEventSchema.shape.payload,
);
export const tttVoiceIceEventSchema = event(
  "ttt.voice.ice_candidate",
  voiceIceEventSchema.shape.payload,
);

export const clientEventSchema = z.discriminatedUnion("type", [
  socketAuthenticateEventSchema,
  matchmakingJoinEventSchema,
  matchmakingLeaveEventSchema,
  matchAcceptEventSchema,
  roomReadyEventSchema,
  gameStateRequestEventSchema,
  diceRollEventSchema,
  pawnMoveEventSchema,
  quickChatEventSchema,
  textChatEventSchema,
  typingStartEventSchema,
  typingStopEventSchema,
  voiceJoinEventSchema,
  voiceLeaveEventSchema,
  voiceOfferEventSchema,
  voiceAnswerEventSchema,
  voiceIceEventSchema,
  playerReportEventSchema,
  playerBlockEventSchema,
  playerMuteEventSchema,
  roomLeaveEventSchema,
  socketPingEventSchema,
  tttMatchmakingJoinEventSchema,
  tttMatchmakingLeaveEventSchema,
  tttStateRequestEventSchema,
  tttMoveEventSchema,
  tttMatchLeaveEventSchema,
  tttQuickChatEventSchema,
  tttTextChatEventSchema,
  tttVoiceJoinEventSchema,
  tttVoiceLeaveEventSchema,
  tttVoiceOfferEventSchema,
  tttVoiceAnswerEventSchema,
  tttVoiceIceEventSchema,
]);
export type LudoClientEvent = z.infer<typeof clientEventSchema>;

export const SERVER_EVENT_TYPES = [
  "socket.authenticated",
  "socket.session_replaced",
  "matchmaking.joined",
  "matchmaking.updated",
  "matchmaking.left",
  "match.found",
  "match.cancelled",
  "room.created",
  "room.player_joined",
  "room.player_left",
  "room.player_disconnected",
  "room.player_reconnected",
  "game.started",
  "game.state",
  "game.events",
  "dice.rolled",
  "pawn.moved",
  "pawn.captured",
  "turn.changed",
  "timer.updated",
  "chat.quick.received",
  "chat.text.received",
  "chat.typing",
  "voice.participant_updated",
  "voice.offer",
  "voice.answer",
  "voice.ice_candidate",
  "game.player_finished",
  "game.finished",
  "game.forfeited",
  "entitlement.updated",
  "socket.pong",
  "game.error",
  "ttt.matchmaking.joined",
  "ttt.matchmaking.left",
  "ttt.match.found",
  "ttt.match.updated",
  "ttt.match.finished",
  "ttt.chat.received",
] as const;
export type LudoServerEventType = (typeof SERVER_EVENT_TYPES)[number];

export interface LudoServerEvent<TPayload = unknown> {
  type: LudoServerEventType;
  eventId: string;
  gameId: string | null;
  stateVersion: number | null;
  serverTimestamp: string;
  payload: TPayload;
}

export const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type LudoHistoryQuery = z.infer<typeof historyQuerySchema>;

export const createSubscriptionOrderSchema = z.object({ plan: z.enum(["PLUS", "PRO"]) });
export type CreateSubscriptionOrderInput = z.infer<typeof createSubscriptionOrderSchema>;

export const verifySubscriptionSchema = z.object({
  subscriptionId: z
    .string()
    .regex(/^sub_[A-Za-z0-9]+$/)
    .max(100),
  paymentId: z
    .string()
    .regex(/^pay_[A-Za-z0-9]+$/)
    .max(100),
  signature: z.string().regex(/^[a-f0-9]{64}$/i),
});
export type VerifySubscriptionInput = z.infer<typeof verifySubscriptionSchema>;

export const restPlayerReportSchema = z.object({
  gameId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  category: z.enum(["ABUSE", "SPAM", "CHEATING", "VOICE", "OTHER"]),
  details: z.string().trim().max(500).optional(),
  messageId: z.string().uuid().optional(),
});
export type RestPlayerReportInput = z.infer<typeof restPlayerReportSchema>;

export const restPlayerBlockSchema = z.object({ userId: z.string().uuid() });
export type RestPlayerBlockInput = z.infer<typeof restPlayerBlockSchema>;

export const adminRoomsQuerySchema = historyQuerySchema.extend({
  status: z
    .enum(["MATCHED", "WAITING_READY", "ACTIVE", "COMPLETED", "CANCELLED", "ABANDONED", "EXPIRED"])
    .optional(),
  mode: ludoModeSchema.optional(),
  search: z.string().trim().max(200).optional(),
});
export type AdminRoomsQuery = z.infer<typeof adminRoomsQuerySchema>;

export const adminMatchesQuerySchema = adminRoomsQuerySchema.extend({
  search: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type AdminMatchesQuery = z.infer<typeof adminMatchesQuerySchema>;

export const adminPlayersQuerySchema = historyQuerySchema.extend({
  search: z.string().trim().max(200).optional(),
});
export type AdminPlayersQuery = z.infer<typeof adminPlayersQuerySchema>;

export const adminReportsQuerySchema = historyQuerySchema.extend({
  status: z.enum(["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"]).optional(),
});
export type AdminReportsQuery = z.infer<typeof adminReportsQuerySchema>;

export const adminPaymentEventsQuerySchema = historyQuerySchema.extend({
  status: z.enum(["PROCESSING", "PROCESSED", "IGNORED", "FAILED"]).optional(),
});
export type AdminPaymentEventsQuery = z.infer<typeof adminPaymentEventsQuerySchema>;

export const uuidParamsSchema = z.object({ id: z.string().uuid() });
export const userIdParamsSchema = z.object({ userId: z.string().uuid() });
export type UuidParams = z.infer<typeof uuidParamsSchema>;
export type UserIdParams = z.infer<typeof userIdParamsSchema>;

export const resolveReportSchema = z.object({
  resolution: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).optional(),
});
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;

export const updatePlayerRestrictionsSchema = z
  .object({
    gameSuspendedUntil: z.string().datetime({ offset: true }).nullable().optional(),
    chatMutedUntil: z.string().datetime({ offset: true }).nullable().optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine(
    (value) => value.gameSuspendedUntil !== undefined || value.chatMutedUntil !== undefined,
    "At least one restriction field is required",
  );
export type UpdatePlayerRestrictionsInput = z.infer<typeof updatePlayerRestrictionsSchema>;

export const updateLudoConfigSchema = z.object({
  values: z.record(z.string().startsWith("game.ludo."), z.string().max(500)),
});
export type UpdateLudoConfigInput = z.infer<typeof updateLudoConfigSchema>;
