import { describe, expect, it, vi } from "vitest";
import { applyRoll, createInitialState, startGame, type LudoEngineState } from "../engine/ludo.js";
import { LudoRealtimeHub } from "../sockets/ludo-hub.js";
import { hashToken } from "../../../utils/tokens.js";
import { LudoService } from "./ludo.service.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn(() => 2) };
});

const USER_ID = "red-user";
const OTHER_USER_ID = "yellow-user";
const GAME_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-02T12:00:00.000Z");

const engineState = (): LudoEngineState =>
  startGame(
    createInitialState({
      gameId: GAME_ID,
      mode: "TWO_PLAYER",
      userIds: [USER_ID, OTHER_USER_ID],
      now: "2026-08-02T11:59:00.000Z",
      startingSeat: 0,
    }),
    "2026-08-02T11:59:00.000Z",
  );

const makeHarness = (state: LudoEngineState, turnDeadline: Date) => {
  const roomUpdate = vi.fn(async (_input: unknown) => undefined);
  const playerUpdate = vi.fn(async (_input: unknown) => undefined);
  const actionCreate = vi.fn(async (_input: unknown) => undefined);
  const actionFindUnique = vi.fn(async (): Promise<any> => null);
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ now: NOW }]),
    ludoAction: {
      findUnique: actionFindUnique,
      create: actionCreate,
    },
    ludoRoom: {
      findUnique: vi.fn(async () => ({
        id: GAME_ID,
        mode: "TWO_PLAYER",
        status: "ACTIVE",
        stateVersion: 0,
        state,
        configSnapshot: { turnDurationSeconds: 17 },
        turnDeadline,
        startedAt: new Date("2026-08-02T11:59:00.000Z"),
        players: [
          { id: "membership-red", userId: USER_ID, status: "ACTIVE", turnTimeouts: 0 },
          { id: "membership-yellow", userId: OTHER_USER_ID, status: "ACTIVE", turnTimeouts: 0 },
        ],
      })),
      update: roomUpdate,
    },
    ludoPlayer: {
      update: playerUpdate,
      findMany: vi.fn(async () => []),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const settings = {
    // These values deliberately represent a disabled maintenance deployment.
    // Active rooms must still use the runtime/frozen numeric rules.
    getBoolean: vi.fn(async (key: string) => {
      if (key === "game.ludo.enabled") return false;
      if (key === "game.ludo.maintenanceMode") return true;
      return true;
    }),
    getNumber: vi.fn(async (key: string) => {
      const values: Record<string, number> = {
        "game.ludo.turnDurationSeconds": 99,
        "game.ludo.reconnectionGraceSeconds": 45,
        "game.ludo.matchAcceptanceSeconds": 20,
        "game.ludo.queueTimeoutSeconds": 120,
        "game.ludo.inactiveForfeitTurns": 3,
        "game.ludo.chatMaxCharacters": 160,
        "game.ludo.chatRateLimitPer10Seconds": 5,
        "game.ludo.freeReactionCount": 3,
        "game.ludo.pawnsPerPlayer": 4,
      };
      return values[key] ?? 1;
    }),
    getString: vi.fn(async (key: string) => (key === "game.ludo.quickMessages" ? '["HELLO"]' : "")),
  };
  const service = new LudoService(
    prisma as never,
    settings as never,
    { enqueue: vi.fn(async () => undefined) } as never,
    new LudoRealtimeHub(),
    {} as never,
  );
  return { service, settings, roomUpdate, playerUpdate, actionCreate, actionFindUnique };
};

describe("active Ludo availability and authoritative deadlines", () => {
  it("keeps an active game playable during master-disable/maintenance and uses its frozen timer", async () => {
    const harness = makeHarness(engineState(), new Date(NOW.getTime() + 5_000));

    const event = await harness.service.rollDice(USER_ID, GAME_ID, "action-roll", 0);

    expect(event).toMatchObject({
      type: "dice.rolled",
      stateVersion: 1,
      payload: {
        dice: 2,
        diceValue: 2,
        stateDice: null,
        phase: "AWAITING_ROLL",
      },
    });

    expect(harness.roomUpdate).toHaveBeenCalledOnce();
    expect(harness.roomUpdate.mock.calls[0]?.[0]).toMatchObject({
      data: { turnDeadline: new Date(NOW.getTime() + 17_000) },
    });
    expect(harness.actionCreate).toHaveBeenCalledOnce();
    expect(harness.settings.getBoolean).not.toHaveBeenCalled();
  });

  it("rejects a late roll under the room lock before any state write", async () => {
    const harness = makeHarness(engineState(), new Date(NOW.getTime() - 1));

    await expect(
      harness.service.rollDice(USER_ID, GAME_ID, "action-late-roll", 0),
    ).rejects.toMatchObject({ statusCode: 409, code: "TURN_DEADLINE_EXPIRED" });

    expect(harness.roomUpdate).not.toHaveBeenCalled();
    expect(harness.playerUpdate).not.toHaveBeenCalled();
    expect(harness.actionCreate).not.toHaveBeenCalled();
  });

  it("rejects a late pawn move under the room lock before any state write", async () => {
    const awaitingMove = applyRoll(engineState(), USER_ID, 6, NOW.toISOString()).state;
    const harness = makeHarness(awaitingMove, new Date(NOW.getTime()));

    await expect(
      harness.service.movePawn(USER_ID, GAME_ID, "action-late-move", 0, 0),
    ).rejects.toMatchObject({ statusCode: 409, code: "TURN_DEADLINE_EXPIRED" });

    expect(harness.roomUpdate).not.toHaveBeenCalled();
    expect(harness.playerUpdate).not.toHaveBeenCalled();
    expect(harness.actionCreate).not.toHaveBeenCalled();
  });

  it("does not replay an action ID owned by another player", async () => {
    const harness = makeHarness(engineState(), new Date(NOW.getTime() + 5_000));
    harness.actionFindUnique.mockResolvedValue({
      userId: OTHER_USER_ID,
      serverEvent: { type: "dice.rolled" },
    });

    await expect(harness.service.rollDice(USER_ID, GAME_ID, "shared-action", 0)).rejects.toThrow(
      "already used by another player",
    );
    expect(harness.roomUpdate).not.toHaveBeenCalled();
  });

  it("validates room membership before looking up an idempotent action", async () => {
    const harness = makeHarness(engineState(), new Date(NOW.getTime() + 5_000));

    await expect(
      harness.service.rollDice("room-outsider", GAME_ID, "guessed-action", 0),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    expect(harness.actionFindUnique).not.toHaveBeenCalled();
  });
});

const fakeSocket = () =>
  ({ readyState: 1, OPEN: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() }) as never;

const resumeHarness = (params: {
  roomStatus: "MATCHED" | "WAITING_READY" | "ACTIVE";
  playerStatus: "MATCHED" | "ACCEPTED" | "READY" | "ACTIVE" | "DISCONNECTED";
  acceptedAt?: Date | null;
  readyAt?: Date | null;
  lastAcknowledgedVersion?: number;
}) => {
  const currentToken = "a".repeat(48);
  const playerUpdateMany = vi.fn(async () => ({ count: 1 }));
  const player = {
    id: "membership-red",
    roomId: GAME_ID,
    userId: USER_ID,
    status: params.playerStatus,
    resumeTokenHash: hashToken(currentToken),
    lastAcknowledgedVersion: params.lastAcknowledgedVersion ?? 0,
    acceptedAt: params.acceptedAt ?? null,
    readyAt: params.readyAt ?? null,
    room: { id: GAME_ID, status: params.roomStatus, stateVersion: 9 },
  };
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    ludoPlayer: {
      findFirst: vi.fn(async () => player),
      updateMany: playerUpdateMany,
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const hub = new LudoRealtimeHub();
  hub.register({
    userId: USER_ID,
    socket: fakeSocket(),
    gameId: null,
    ludoGameId: null,
    authenticatedAt: Date.now(),
    lastSeenAt: Date.now(),
  });
  const service = new LudoService(prisma as never, {} as never, {} as never, hub, {} as never);
  vi.spyOn(service, "getSnapshot").mockResolvedValue({
    gameId: GAME_ID,
    status: params.roomStatus,
    stateVersion: 9,
  });
  return { currentToken, hub, playerUpdateMany, service };
};

describe("Ludo reconnect recovery", () => {
  it("rejects a stale supplied resume credential with a stable code", async () => {
    const harness = resumeHarness({ roomStatus: "ACTIVE", playerStatus: "ACTIVE" });

    await expect(harness.service.resumeActive(USER_ID, "b".repeat(48), 4)).rejects.toMatchObject({
      statusCode: 401,
      code: "INVALID_RESUME_TOKEN",
    });
    expect(harness.playerUpdateMany).not.toHaveBeenCalled();
  });

  it("rotates a valid credential without decreasing the acknowledged version", async () => {
    const harness = resumeHarness({
      roomStatus: "ACTIVE",
      playerStatus: "DISCONNECTED",
      lastAcknowledgedVersion: 7,
    });

    const resumed = await harness.service.resumeActive(USER_ID, harness.currentToken, 3);

    expect(resumed).toMatchObject({
      gameId: GAME_ID,
      event: { type: "game.state", stateVersion: 9 },
    });
    expect(resumed?.resumeToken).not.toBe(harness.currentToken);
    expect(harness.playerUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastAcknowledgedVersion: 7, status: "ACTIVE" }),
      }),
    );
    expect(harness.hub.session(USER_ID)?.ludoGameId).toBe(GAME_ID);
  });

  it.each([
    { roomStatus: "MATCHED" as const, playerStatus: "MATCHED" as const, eventType: "match.found" },
    {
      roomStatus: "WAITING_READY" as const,
      playerStatus: "ACCEPTED" as const,
      eventType: "room.created",
    },
    {
      roomStatus: "WAITING_READY" as const,
      playerStatus: "READY" as const,
      eventType: "room.player_joined",
    },
  ])("replays the $playerStatus pregame handshake as $eventType", async (fixture) => {
    const harness = resumeHarness(fixture);

    const resumed = await harness.service.resumeActive(USER_ID, undefined, 2);

    expect(resumed?.event).toMatchObject({
      type: fixture.eventType,
      gameId: GAME_ID,
      stateVersion: 9,
      payload: {
        recovery: true,
        pregamePhase: fixture.roomStatus,
        playerHandshakeStatus: fixture.playerStatus,
        snapshot: { gameId: GAME_ID, status: fixture.roomStatus },
      },
    });
  });
});

const runtimeSettings = () => ({
  getBoolean: vi.fn(async (key: string) => key !== "game.ludo.maintenanceMode"),
  getNumber: vi.fn(async (key: string) => {
    const values: Record<string, number> = {
      "game.ludo.turnDurationSeconds": 30,
      "game.ludo.reconnectionGraceSeconds": 45,
      "game.ludo.matchAcceptanceSeconds": 20,
      "game.ludo.queueTimeoutSeconds": 120,
      "game.ludo.inactiveForfeitTurns": 3,
      "game.ludo.chatMaxCharacters": 160,
      "game.ludo.chatRateLimitPer10Seconds": 5,
      "game.ludo.freeReactionCount": 3,
      "game.ludo.pawnsPerPlayer": 4,
    };
    return values[key] ?? 1;
  }),
  getString: vi.fn(async (key: string) => (key === "game.ludo.quickMessages" ? '["HELLO"]' : "")),
});

describe("Ludo disconnect reconciliation", () => {
  it("does not let late cleanup cancel a replacement socket's queue or presence", async () => {
    let releaseLock!: () => void;
    let lockStarted!: () => void;
    const waitForRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const didStartLock = new Promise<void>((resolve) => {
      lockStarted = resolve;
    });
    let lockCalls = 0;
    const queueUpdate = vi.fn(async () => ({ count: 1 }));
    const playerFind = vi.fn(async () => null);
    const tx = {
      $executeRaw: vi.fn(async () => {
        lockCalls += 1;
        if (lockCalls === 1) {
          lockStarted();
          await waitForRelease;
        }
        return 0;
      }),
      ludoQueueEntry: { updateMany: queueUpdate },
      ludoPlayer: { findFirst: playerFind },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const hub = new LudoRealtimeHub();
    const service = new LudoService(
      prisma as never,
      runtimeSettings() as never,
      {} as never,
      hub,
      {} as never,
    );

    const cleanup = service.markDisconnected(USER_ID);
    await didStartLock;
    hub.register({
      userId: USER_ID,
      socket: fakeSocket(),
      gameId: null,
      ludoGameId: GAME_ID,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    releaseLock();
    await cleanup;

    expect(queueUpdate).not.toHaveBeenCalled();
    expect(playerFind).not.toHaveBeenCalled();
    expect(hub.session(USER_ID)?.ludoGameId).toBe(GAME_ID);
  });

  it("keeps a pregame room recoverable instead of cancelling it on a socket blip", async () => {
    const acceptanceDeadline = new Date(NOW.getTime() + 20_000);
    const queueUpdate = vi.fn(async () => ({ count: 0 }));
    const playerUpdate = vi.fn(async () => ({ count: 0 }));
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      ludoQueueEntry: { updateMany: queueUpdate },
      ludoPlayer: {
        findFirst: vi.fn(async () => ({
          id: "membership-red",
          roomId: GAME_ID,
          status: "ACCEPTED",
          room: {
            status: "WAITING_READY",
            stateVersion: 4,
            acceptanceDeadline,
          },
        })),
        updateMany: playerUpdate,
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const hub = new LudoRealtimeHub();
    const peerSocket = fakeSocket() as any;
    hub.register({
      userId: OTHER_USER_ID,
      socket: peerSocket,
      gameId: null,
      ludoGameId: GAME_ID,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    const service = new LudoService(
      prisma as never,
      runtimeSettings() as never,
      {} as never,
      hub,
      {} as never,
    );

    await service.markDisconnected(USER_ID);

    expect(playerUpdate).not.toHaveBeenCalled();
    expect(peerSocket.send).toHaveBeenCalledOnce();
    expect(JSON.parse(peerSocket.send.mock.calls[0][0])).toMatchObject({
      type: "room.player_disconnected",
      gameId: GAME_ID,
      stateVersion: 4,
      payload: {
        userId: USER_ID,
        pregame: true,
        reconnectDeadline: acceptanceDeadline.toISOString(),
      },
    });
  });
});

describe("cross-game matchmaking isolation", () => {
  it("does not let Ludo overwrite an active Tic-tac-toe route", async () => {
    const transaction = vi.fn();
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ isActive: true })) },
      ludoRestriction: { findFirst: vi.fn(async () => null) },
      $transaction: transaction,
    };
    const hub = new LudoRealtimeHub();
    hub.register({
      userId: USER_ID,
      socket: fakeSocket(),
      gameId: "active-ttt-match",
      ludoGameId: null,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    const service = new LudoService(
      prisma as never,
      runtimeSettings() as never,
      {} as never,
      hub,
      {} as never,
    );

    await expect(service.joinMatchmaking(USER_ID, { mode: "TWO_PLAYER" })).rejects.toThrow(
      "Finish your active Tic-tac-toe match",
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(hub.session(USER_ID)?.gameId).toBe("active-ttt-match");
    expect(hub.session(USER_ID)?.ludoGameId).toBeNull();
  });
});
