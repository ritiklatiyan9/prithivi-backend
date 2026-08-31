import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../common/errors.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import { catalogPlan } from "../../ludo/services/ludo-subscription-catalog.js";
import type { LudoRealtimeHub } from "../../ludo/sockets/ludo-hub.js";
import {
  applyMove,
  checkWin,
  chooseAiMove,
  initialState,
  MAX_PLIES,
  type Difficulty,
  type GameState,
} from "../engine/tictactoe.js";
import type { MoveResultDto, StartMatchDto, TttConfigDto } from "../schemas/game.schema.js";

const DIFFICULTIES: readonly Difficulty[] = ["EASY", "MEDIUM", "HARD", "IMPOSSIBLE"];

type MatchStatus = "IN_PROGRESS" | "WON" | "LOST" | "DRAW";
type MembershipPlan = "FREE" | "PLUS" | "PRO";

interface MembershipAccess {
  plan: MembershipPlan;
  textChat: boolean;
  voiceChat: boolean;
}

type OnlineGameState = GameState & {
  xUserId: string;
  oUserId: string;
  currentTurnUserId: string;
  winnerUserId: string | null;
  version: number;
};

const onlineMatchTails = new Map<string, Promise<void>>();
const onlineVoiceParticipants = new Map<string, Set<string>>();
const ONLINE_QUICK_MESSAGES = new Set(["HELLO", "GOOD_MOVE", "WELL_PLAYED", "GOOD_GAME"]);

function runOnlineMatchExclusive<T>(matchId: string, operation: () => Promise<T>): Promise<T> {
  const previous = onlineMatchTails.get(matchId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  onlineMatchTails.set(matchId, tail);
  void tail.then(() => {
    if (onlineMatchTails.get(matchId) === tail) onlineMatchTails.delete(matchId);
  });
  return result;
}

type CachedMatch = {
  state: GameState;
  status: MatchStatus;
  difficulty: Difficulty;
  hintsEnabled: boolean; // snapshot at start — decides the win payout
  userId: string;
  updatedAt: number; // last-touch ms, used by the sweep
};

// HOT PATH: in-memory match cache so a move never waits on the cloud DB.
// ponytail: single-process cache; move to Redis if this ever runs multi-instance.
const matchCache = new Map<string, CachedMatch>();
const MATCH_CACHE_MAX = 5000;
const MATCH_CACHE_TTL_MS = 60 * 60 * 1000;
setInterval(
  () => {
    const cutoff = Date.now() - MATCH_CACHE_TTL_MS;
    for (const [id, entry] of matchCache) if (entry.updatedAt < cutoff) matchCache.delete(id);
  },
  10 * 60 * 1000,
).unref();

function cacheSet(matchId: string, entry: CachedMatch): void {
  if (!matchCache.has(matchId) && matchCache.size >= MATCH_CACHE_MAX) {
    // ponytail: evicts oldest-inserted, not oldest-touched; fine at 5000 entries.
    matchCache.delete(matchCache.keys().next().value as string);
  }
  matchCache.set(matchId, entry);
}

// Per-match in-flight lock: one move at a time, held until its async persist
// settles, so DB writes for a match can never interleave.
const inflight = new Set<string>();

// ponytail: queries are trivial one-liners, prisma used directly (AppAssetsService precedent) — add a repository if they grow.
export class GameService {
  // Pairing mutates an in-memory queue and performs asynchronous eligibility /
  // persistence checks. Keep those operations in one FIFO critical section so
  // reconnects and simultaneous joins cannot claim the same player twice.
  private readonly onlineQueue: string[] = [];
  private onlineMatchmakingTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly hub: LudoRealtimeHub,
  ) {}

  private async difficulty(): Promise<Difficulty> {
    const value = await this.settings.getString("game.ttt.difficulty");
    return DIFFICULTIES.includes(value as Difficulty) ? (value as Difficulty) : "MEDIUM";
  }

  private async playedToday(userId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.prisma.gameMatch.count({
      where: {
        OR: [
          { userId },
          {
            difficulty: "ONLINE",
            state: { path: ["oUserId"], equals: userId },
          },
        ],
        createdAt: { gte: startOfDay },
        // Grace for accidental opens: an IN_PROGRESS match with zero moves that
        // is >10 min old was never really played, so it doesn't spend the limit.
        NOT: {
          status: "IN_PROGRESS",
          createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
          state: { path: ["plies"], equals: 0 },
        },
      },
    });
  }

  private async membershipAccess(userId: string): Promise<MembershipAccess> {
    const entitlement = await this.prisma.ludoEntitlement.findUnique({
      where: { userId },
      select: { plan: true, status: true, expiresAt: true },
    });
    const paidIsActive =
      entitlement !== null &&
      entitlement.plan !== "FREE" &&
      entitlement.status === "ACTIVE" &&
      entitlement.expiresAt !== null &&
      entitlement.expiresAt.getTime() > Date.now();
    const plan: MembershipPlan = paidIsActive ? entitlement.plan : "FREE";
    const benefits = catalogPlan(plan).entitlements;
    return {
      plan,
      textChat: benefits.textChat,
      voiceChat: benefits.voiceChat,
    };
  }

  private dailyLimitKey(plan: MembershipPlan): string {
    return {
      FREE: "game.ttt.freeDailyLimit",
      PLUS: "game.ttt.plusDailyLimit",
      PRO: "game.ttt.proDailyLimit",
    }[plan];
  }

  private async assertCanStart(userId: string): Promise<void> {
    if (!(await this.settings.getBoolean("game.ttt.enabled"))) {
      throw new ForbiddenError("Tic-tac-toe is currently disabled");
    }
    const membership = await this.membershipAccess(userId);
    const dailyLimit = await this.settings.getNumber(this.dailyLimitKey(membership.plan));
    if ((await this.playedToday(userId)) >= dailyLimit) {
      throw new ConflictError("You've reached today's match limit");
    }
  }

  async getConfig(userId: string): Promise<TttConfigDto> {
    const [enabled, winCoins, hintWinCoins, difficulty, membership, playedToday] =
      await Promise.all([
        this.settings.getBoolean("game.ttt.enabled"),
        this.settings.getNumber("game.ttt.winCoins"),
        this.settings.getNumber("game.ttt.hintWinCoins"),
        this.difficulty(),
        this.membershipAccess(userId),
        this.playedToday(userId),
      ]);
    const dailyLimit = await this.settings.getNumber(this.dailyLimitKey(membership.plan));
    return {
      enabled,
      winCoins,
      hintWinCoins,
      difficulty,
      membershipPlan: membership.plan,
      textChatEnabled: membership.textChat,
      voiceChatEnabled: membership.voiceChat,
      dailyLimit,
      playedToday,
      remaining: Math.max(0, dailyLimit - playedToday),
    };
  }

  async startMatch(userId: string, hints = false): Promise<StartMatchDto> {
    await this.assertCanStart(userId);

    const state = initialState();
    const match = await this.prisma.gameMatch.create({
      data: {
        userId,
        state: state as unknown as Prisma.InputJsonValue,
        difficulty: await this.difficulty(),
        hintsEnabled: hints,
      },
    });
    cacheSet(match.id, {
      state,
      status: "IN_PROGRESS",
      difficulty: match.difficulty as Difficulty,
      hintsEnabled: match.hintsEnabled,
      userId,
      updatedAt: Date.now(),
    });
    return {
      matchId: match.id,
      board: state.board,
      yourSymbol: "X",
      hintsEnabled: match.hintsEnabled,
    };
  }

  private onlineState(value: Prisma.JsonValue): OnlineGameState {
    const state = value as unknown as OnlineGameState;
    if (!state.xUserId || !state.oUserId || !state.currentTurnUserId) {
      throw new AppError("Online match state is invalid", 500, "ONLINE_MATCH_INVALID");
    }
    return state;
  }

  private async onlineSnapshot(matchId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.gameMatch.findUnique({ where: { id: matchId } });
    if (!row || row.difficulty !== "ONLINE") throw new NotFoundError("Online match not found");
    const state = this.onlineState(row.state);
    const users = await this.prisma.user.findMany({
      where: { id: { in: [state.xUserId, state.oUserId] } },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((user) => [user.id, user.name?.trim() || "Player"]));
    return {
      matchId: row.id,
      board: state.board,
      xUserId: state.xUserId,
      oUserId: state.oUserId,
      currentTurnUserId: state.currentTurnUserId,
      winnerUserId: state.winnerUserId,
      version: state.version,
      status: row.status === "IN_PROGRESS" ? "IN_PROGRESS" : state.winnerUserId ? "WON" : "DRAW",
      players: [
        { userId: state.xUserId, name: names.get(state.xUserId) ?? "Player", symbol: "X" },
        { userId: state.oUserId, name: names.get(state.oUserId) ?? "Player", symbol: "O" },
      ],
    };
  }

  private activeOnlineMatch(userId: string) {
    return this.prisma.gameMatch.findFirst({
      where: {
        difficulty: "ONLINE",
        status: "IN_PROGRESS",
        OR: [{ userId }, { state: { path: ["oUserId"], equals: userId } }],
      },
      orderBy: { createdAt: "desc" },
    });
  }

  private removeOnlineQueueEntries(userId: string): void {
    let index = this.onlineQueue.indexOf(userId);
    while (index >= 0) {
      this.onlineQueue.splice(index, 1);
      index = this.onlineQueue.indexOf(userId);
    }
  }

  private enqueueOnlineUser(userId: string, front = false): void {
    this.removeOnlineQueueEntries(userId);
    if (front) this.onlineQueue.unshift(userId);
    else this.onlineQueue.push(userId);
  }

  private runOnlineMatchmakingExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.onlineMatchmakingTail.then(operation, operation);
    this.onlineMatchmakingTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async sendExistingOnlineMatch(
    userId: string,
    active: NonNullable<Awaited<ReturnType<GameService["activeOnlineMatch"]>>>,
  ): Promise<void> {
    const state = this.onlineState(active.state);
    const session = this.hub.session(userId);
    if (!session) throw new ConflictError("Realtime session is not connected");
    // Ludo and TTT route independently in the hub, but simultaneous games are
    // still disallowed: a player cannot fairly participate in both at once.
    if (
      session.ludoGameId != null ||
      (session.gameId !== null && session.gameId !== active.id)
    ) {
      throw new ConflictError("Finish your current realtime game before joining Tic-tac-toe");
    }
    this.hub.setGame(userId, active.id);
    this.hub.send(
      userId,
      this.hub.event(
        "ttt.match.found",
        { snapshot: await this.onlineSnapshot(active.id) },
        active.id,
        state.version,
      ),
    );
  }

  private async onlineRowForMember(userId: string, matchId: string) {
    const row = await this.prisma.gameMatch.findUnique({ where: { id: matchId } });
    if (!row || row.difficulty !== "ONLINE") throw new NotFoundError("Online match not found");
    const state = this.onlineState(row.state);
    if (state.xUserId !== userId && state.oUserId !== userId) {
      throw new NotFoundError("Online match not found");
    }
    return { row, state };
  }

  private sendOnlinePlayers(
    state: OnlineGameState,
    event: ReturnType<LudoRealtimeHub["event"]>,
  ): void {
    this.hub.send(state.xUserId, event);
    this.hub.send(state.oUserId, event);
  }

  async joinOnlineMatchmaking(userId: string): Promise<void> {
    if (!this.hub.session(userId)) throw new ConflictError("Realtime session is not connected");

    await this.runOnlineMatchmakingExclusive(async () => {
      const active = await this.activeOnlineMatch(userId);
      if (active) {
        this.removeOnlineQueueEntries(userId);
        await this.sendExistingOnlineMatch(userId, active);
        return;
      }
      await this.assertCanStart(userId);

      const joiningSession = this.hub.session(userId);
      if (!joiningSession) throw new ConflictError("Realtime session is not connected");
      if (joiningSession.gameId !== null || joiningSession.ludoGameId != null) {
        throw new ConflictError("Finish your current realtime game before joining Tic-tac-toe");
      }

      // A reconnect is an idempotent rescan: keep at most one queue row for the
      // user, then look for another connected and unclaimed player.
      this.removeOnlineQueueEntries(userId);
      let opponentId: string | null = null;
      for (;;) {
        const opponentIndex = this.onlineQueue.findIndex(
          (candidate) => candidate !== userId && this.hub.session(candidate) !== undefined,
        );
        if (opponentIndex < 0) {
          this.enqueueOnlineUser(userId);
          this.hub.send(userId, this.hub.event("ttt.matchmaking.joined", { searching: true }));
          return;
        }

        const candidateId = this.onlineQueue.splice(opponentIndex, 1)[0]!;
        try {
          const candidateActive = await this.activeOnlineMatch(candidateId);
          if (candidateActive) {
            await this.sendExistingOnlineMatch(candidateId, candidateActive);
            continue;
          }
          await this.assertCanStart(candidateId);
          const candidateSession = this.hub.session(candidateId);
          if (
            !candidateSession ||
            candidateSession.gameId !== null ||
            candidateSession.ludoGameId != null
          ) {
            this.hub.send(
              candidateId,
              this.hub.event("ttt.matchmaking.left", { searching: false }),
            );
            continue;
          }
          opponentId = candidateId;
          break;
        } catch {
          // A stale/disconnected/ineligible candidate must not wedge the next
          // valid player behind it.
          this.hub.send(
            candidateId,
            this.hub.event("ttt.matchmaking.left", { searching: false }),
          );
        }
      }

      if (!opponentId) return;
      const currentJoiningSession = this.hub.session(userId);
      const currentOpponentSession = this.hub.session(opponentId);
      if (
        !currentJoiningSession ||
        currentJoiningSession.gameId !== null ||
        currentJoiningSession.ludoGameId != null
      ) {
        if (
          currentOpponentSession?.gameId === null &&
          currentOpponentSession.ludoGameId == null
        ) {
          this.enqueueOnlineUser(opponentId, true);
        }
        throw new ConflictError("Realtime session changed while joining");
      }
      if (
        !currentOpponentSession ||
        currentOpponentSession.gameId !== null ||
        currentOpponentSession.ludoGameId != null
      ) {
        this.enqueueOnlineUser(userId);
        this.hub.send(userId, this.hub.event("ttt.matchmaking.joined", { searching: true }));
        return;
      }

      const first = Math.random() < 0.5 ? opponentId : userId;
      const second = first === opponentId ? userId : opponentId;
      const initial = initialState();
      const state: OnlineGameState = {
        ...initial,
        xUserId: first,
        oUserId: second,
        currentTurnUserId: first,
        winnerUserId: null,
        version: 1,
      };
      let row: Awaited<ReturnType<PrismaClient["gameMatch"]["create"]>>;
      try {
        row = await this.prisma.gameMatch.create({
          data: {
            userId: first,
            difficulty: "ONLINE",
            hintsEnabled: false,
            state: state as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        // Creation is the claim commit. Restore both still-connected players so
        // a transient DB failure/retry cannot silently drop the opponent.
        const opponentSession = this.hub.session(opponentId);
        const userSession = this.hub.session(userId);
        if (opponentSession?.gameId === null && opponentSession.ludoGameId == null) {
          this.enqueueOnlineUser(opponentId, true);
        }
        if (userSession?.gameId === null && userSession.ludoGameId == null) {
          this.enqueueOnlineUser(userId);
        }
        throw error;
      }

      this.hub.setGame(first, row.id);
      this.hub.setGame(second, row.id);
      const snapshot = await this.onlineSnapshot(row.id);
      this.sendOnlinePlayers(
        state,
        this.hub.event("ttt.match.found", { snapshot }, row.id, state.version),
      );
    });
  }

  async leaveOnlineMatchmaking(userId: string): Promise<void> {
    let matchedDuringLeave: string | null = null;
    await this.runOnlineMatchmakingExclusive(async () => {
      this.removeOnlineQueueEntries(userId);
      // A different socket may have claimed this user just before their cancel
      // command acquired the pairing lock. Resolve that freshly-created match
      // as a leave instead of emitting `left` while stranding the opponent.
      const active = await this.activeOnlineMatch(userId);
      if (active) matchedDuringLeave = active.id;
      else this.hub.send(userId, this.hub.event("ttt.matchmaking.left", { searching: false }));
    });
    if (matchedDuringLeave) await this.leaveOnlineMatch(userId, matchedDuringLeave);
  }

  async disconnectOnline(userId: string): Promise<void> {
    await this.runOnlineMatchmakingExclusive(async () => {
      // Socket close cleanup is fire-and-forget. A replacement socket may have
      // authenticated and rejoined before this operation reaches the queue;
      // never let the stale close remove that newer session's queue entry.
      if (this.hub.session(userId)) return;
      this.removeOnlineQueueEntries(userId);
    });
  }

  async sendOnlineState(userId: string, matchId: string): Promise<void> {
    const { row, state } = await this.onlineRowForMember(userId, matchId);
    const session = this.hub.session(userId);
    if (!session) throw new ConflictError("Realtime session is not connected");
    if (
      session.ludoGameId != null ||
      (session.gameId !== null && session.gameId !== matchId)
    ) {
      throw new ConflictError(
        "Finish your current realtime game before resuming Tic-tac-toe",
      );
    }
    // A missed terminal broadcast must not leave the recovered socket pinned
    // to a completed match and block its next matchmaking request.
    this.hub.setGame(userId, row.status === "IN_PROGRESS" ? matchId : null);
    this.hub.send(
      userId,
      this.hub.event(
        "ttt.match.updated",
        { snapshot: await this.onlineSnapshot(matchId) },
        matchId,
        state.version,
      ),
    );
  }

  async onlineMove(userId: string, matchId: string, cell: number): Promise<void> {
    await runOnlineMatchExclusive(matchId, async () => {
      const { row, state } = await this.onlineRowForMember(userId, matchId);
      if (row.status !== "IN_PROGRESS") throw new ConflictError("This match has finished");
      if (state.currentTurnUserId !== userId) throw new ConflictError("Wait for your turn");
      if (state.board[cell] !== null) throw new BadRequestError("Cell is already occupied");
      const symbol = state.xUserId === userId ? "X" : "O";
      const moved = applyMove(state, symbol, cell).state;
      const won = checkWin(moved.board, symbol);
      const draw = !won && moved.plies >= MAX_PLIES;
      const nextTurnUserId = symbol === "X" ? state.oUserId : state.xUserId;
      const next: OnlineGameState = {
        ...moved,
        xUserId: state.xUserId,
        oUserId: state.oUserId,
        currentTurnUserId: won || draw ? userId : nextTurnUserId,
        winnerUserId: won ? userId : null,
        version: state.version + 1,
      };
      const status: MatchStatus = won
        ? symbol === "X"
          ? "WON"
          : "LOST"
        : draw
          ? "DRAW"
          : "IN_PROGRESS";
      await this.prisma.gameMatch.update({
        where: { id: matchId },
        data: { state: next as unknown as Prisma.InputJsonValue, status },
      });
      const snapshot = await this.onlineSnapshot(matchId);
      this.sendOnlinePlayers(
        next,
        this.hub.event(
          won || draw ? "ttt.match.finished" : "ttt.match.updated",
          { snapshot },
          matchId,
          next.version,
        ),
      );
      if (won || draw) {
        this.hub.setGame(next.xUserId, null);
        this.hub.setGame(next.oUserId, null);
        onlineVoiceParticipants.delete(matchId);
      }
    });
  }

  async leaveOnlineMatch(userId: string, matchId: string): Promise<void> {
    await runOnlineMatchExclusive(matchId, async () => {
      const { row, state } = await this.onlineRowForMember(userId, matchId);
      if (row.status !== "IN_PROGRESS") {
        this.hub.setGame(userId, null);
        return;
      }
      const winnerUserId = state.xUserId === userId ? state.oUserId : state.xUserId;
      const next: OnlineGameState = {
        ...state,
        winnerUserId,
        currentTurnUserId: winnerUserId,
        version: state.version + 1,
      };
      await this.prisma.gameMatch.update({
        where: { id: matchId },
        data: {
          state: next as unknown as Prisma.InputJsonValue,
          status: winnerUserId === state.xUserId ? "WON" : "LOST",
        },
      });
      const snapshot = await this.onlineSnapshot(matchId);
      this.sendOnlinePlayers(
        next,
        this.hub.event(
          "ttt.match.finished",
          { snapshot, reason: "PLAYER_LEFT" },
          matchId,
          next.version,
        ),
      );
      this.hub.setGame(state.xUserId, null);
      this.hub.setGame(state.oUserId, null);
      onlineVoiceParticipants.delete(matchId);
    });
  }

  async sendOnlineChat(
    userId: string,
    matchId: string,
    input: string,
    text: boolean,
  ): Promise<void> {
    const { state } = await this.onlineRowForMember(userId, matchId);
    const message = input.trim();
    if (text) {
      const membership = await this.membershipAccess(userId);
      if (!membership.textChat) throw new ForbiddenError("Plus or Pro membership is required");
      if (!message || message.length > 160)
        throw new BadRequestError("Message must be 1 to 160 characters");
    } else if (!ONLINE_QUICK_MESSAGES.has(message.toUpperCase())) {
      throw new BadRequestError("Quick message is not available");
    }
    this.sendOnlinePlayers(
      state,
      this.hub.event(
        "ttt.chat.received",
        {
          userId,
          message: text ? message : message.toUpperCase(),
          kind: text ? "TEXT" : "QUICK",
          createdAt: new Date().toISOString(),
        },
        matchId,
        state.version,
      ),
    );
  }

  async joinOnlineVoice(userId: string, matchId: string): Promise<void> {
    const [{ state }, membership] = await Promise.all([
      this.onlineRowForMember(userId, matchId),
      this.membershipAccess(userId),
    ]);
    if (!membership.voiceChat) throw new ForbiddenError("Pro membership is required for voice");
    const participants = onlineVoiceParticipants.get(matchId) ?? new Set<string>();
    participants.add(userId);
    onlineVoiceParticipants.set(matchId, participants);
    this.sendOnlinePlayers(
      state,
      this.hub.event(
        "voice.participant_updated",
        {
          userId,
          joined: true,
          participants: [...participants],
          offerInitiatorUserId: userId,
        },
        matchId,
        state.version,
      ),
    );
  }

  async leaveOnlineVoice(userId: string, matchId: string): Promise<void> {
    const { state } = await this.onlineRowForMember(userId, matchId);
    const participants = onlineVoiceParticipants.get(matchId) ?? new Set<string>();
    participants.delete(userId);
    this.sendOnlinePlayers(
      state,
      this.hub.event(
        "voice.participant_updated",
        { userId, joined: false, participants: [...participants] },
        matchId,
        state.version,
      ),
    );
  }

  async relayOnlineVoice(
    userId: string,
    matchId: string,
    type: "ttt.voice.offer" | "ttt.voice.answer" | "ttt.voice.ice_candidate",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const membership = await this.membershipAccess(userId);
    if (!membership.voiceChat) throw new ForbiddenError("Pro membership is required for voice");
    await this.onlineRowForMember(userId, matchId);
    const targetUserId = payload.targetUserId?.toString();
    if (!targetUserId) throw new BadRequestError("Voice target is required");
    await this.onlineRowForMember(targetUserId, matchId);
    const participants = onlineVoiceParticipants.get(matchId);
    if (!participants?.has(userId) || !participants.has(targetUserId)) {
      throw new ForbiddenError("Both players must join voice before signalling");
    }
    const outputType = type.replace("ttt.", "") as
      "voice.offer" | "voice.answer" | "voice.ice_candidate";
    this.hub.send(
      targetUserId,
      this.hub.event(outputType, { ...payload, fromUserId: userId }, matchId, null),
    );
  }

  async move(userId: string, matchId: string, cell: number): Promise<MoveResultDto> {
    if (inflight.has(matchId)) {
      throw new ConflictError("A move on this match is already being processed");
    }
    inflight.add(matchId);
    // On the non-terminal path the lock is handed off to the async persist
    // chain; everywhere else the finally below releases it.
    let lockHandedOff = false;
    try {
      let cached = matchCache.get(matchId);
      if (!cached) {
        // Cache miss (e.g. server restart mid-match): fall back to the DB,
        // then repopulate so subsequent moves stay on the hot path.
        const match = await this.prisma.gameMatch.findUnique({ where: { id: matchId } });
        if (!match || match.userId !== userId) throw new NotFoundError("Match not found");
        cached = {
          state: match.state as unknown as GameState,
          status: match.status,
          difficulty: match.difficulty as Difficulty,
          hintsEnabled: match.hintsEnabled,
          userId: match.userId,
          updatedAt: Date.now(),
        };
        cacheSet(matchId, cached);
      }
      if (cached.userId !== userId) throw new NotFoundError("Match not found");
      if (cached.status !== "IN_PROGRESS") throw new ConflictError("Match is already finished");

      const state = cached.state;
      if (state.board[cell] !== null) throw new BadRequestError("Cell is already occupied");

      // ---- user (X) move ----
      const userMove = applyMove(state, "X", cell);
      let current = userMove.state;
      let aiMove: number | null = null;
      let aiRemovedCell: number | null = null;
      let status: MatchStatus = "IN_PROGRESS";

      if (checkWin(current.board, "X")) {
        status = "WON";
      } else if (current.plies >= MAX_PLIES) {
        status = "DRAW";
      } else {
        // ---- AI (O) move ----
        aiMove = chooseAiMove(current, "O", cached.difficulty);
        const ai = applyMove(current, "O", aiMove);
        current = ai.state;
        aiRemovedCell = ai.removedCell;
        if (checkWin(current.board, "O")) status = "LOST";
        else if (current.plies >= MAX_PLIES) status = "DRAW";
      }

      const result: MoveResultDto = {
        board: current.board,
        removedCell: userMove.removedCell,
        aiMove,
        aiRemovedCell,
        status,
        coinsAwarded: null,
      };

      if (status === "IN_PROGRESS") {
        // HOT PATH: update the cache and respond immediately; persist to the
        // cloud DB in the background. The in-flight lock stays held until the
        // write settles, so the next move can't interleave with it.
        cacheSet(matchId, { ...cached, state: current, updatedAt: Date.now() });
        lockHandedOff = true;
        void this.prisma.gameMatch
          .update({
            where: { id: matchId },
            data: { state: current as unknown as Prisma.InputJsonValue },
          })
          .catch((error) => {
            console.error(`[game] async persist failed for match ${matchId}`, error);
          })
          .finally(() => inflight.delete(matchId));
        return result;
      }

      // TERMINAL: persist (final state + wallet credit) synchronously
      // BEFORE responding, then evict from the cache.
      let coinsAwarded: number | null = null;
      if (status === "WON") {
        const [winCoins, hintWinCoins] = await Promise.all([
          this.settings.getNumber("game.ttt.winCoins"),
          this.settings.getNumber("game.ttt.hintWinCoins"),
        ]);
        // Hinted wins pay the (lower) hint rate — snapshot taken at match start.
        coinsAwarded = cached.hintsEnabled ? hintWinCoins : winCoins;
      }
      await this.persist(matchId, userId, current, status, coinsAwarded);
      matchCache.delete(matchId);

      if (status === "WON" && coinsAwarded) {
        await this.notifications.enqueue({
          userId,
          type: "WALLET",
          title: "You beat the AI",
          body: `You won tic-tac-toe and earned ${coinsAwarded} coins!`,
        });
      }

      return { ...result, coinsAwarded };
    } finally {
      if (!lockHandedOff) inflight.delete(matchId);
    }
  }

  /**
   * Persist a terminal move; on WON also credit the wallet in the same
   * transaction. All game computation happens BEFORE this is called — the
   * transaction wraps only the writes, so it commits in milliseconds.
   */
  private async persist(
    matchId: string,
    userId: string,
    state: GameState,
    status: MatchStatus,
    coinsAwarded: number | null,
  ): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        // Guard: only finish a still-in-progress match. In-process races are
        // already serialized by the in-flight lock; this catches replays.
        const updated = await tx.gameMatch.updateMany({
          where: { id: matchId, status: "IN_PROGRESS" },
          data: {
            state: state as unknown as Prisma.InputJsonValue,
            status,
            coinsAwarded: coinsAwarded === null ? undefined : new Prisma.Decimal(coinsAwarded),
          },
        });
        if (updated.count !== 1) throw new ConflictError("Match was updated concurrently");

        if (status === "WON" && coinsAwarded) {
          const wallet = await tx.wallet.upsert({
            where: { userId },
            create: { userId },
            update: {},
          });
          const after = await tx.wallet.update({
            where: { id: wallet.id },
            data: { balance: { increment: coinsAwarded } },
          });
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type: "CREDIT",
              amount: new Prisma.Decimal(coinsAwarded),
              balanceAfter: after.balance,
              reference: `game-ttt:${matchId}`,
              description: "Tic-tac-toe win vs AI",
            },
          });
        }
        // Belt: generous timeout so a briefly busy event loop can't expire the tx.
      },
      { timeout: 10_000 },
    );
  }
}
