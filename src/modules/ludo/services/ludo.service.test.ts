import { describe, expect, it, vi } from "vitest";
import { applyRoll, createInitialState, startGame, type LudoEngineState } from "../engine/ludo.js";
import { LudoRealtimeHub } from "../sockets/ludo-hub.js";
import { LudoService } from "./ludo.service.js";

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
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => [{ now: NOW }]),
    ludoAction: {
      findUnique: vi.fn(async () => null),
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
    getString: vi.fn(async (key: string) =>
      key === "game.ludo.quickMessages" ? '["HELLO"]' : "",
    ),
  };
  const service = new LudoService(
    prisma as never,
    settings as never,
    { enqueue: vi.fn(async () => undefined) } as never,
    new LudoRealtimeHub(),
    {} as never,
  );
  return { service, settings, roomUpdate, playerUpdate, actionCreate };
};

describe("active Ludo availability and authoritative deadlines", () => {
  it("keeps an active game playable during master-disable/maintenance and uses its frozen timer", async () => {
    const harness = makeHarness(engineState(), new Date(NOW.getTime() + 5_000));

    await expect(harness.service.rollDice(USER_ID, GAME_ID, "action-roll", 0)).resolves.toMatchObject({
      type: "dice.rolled",
      stateVersion: 1,
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
});
