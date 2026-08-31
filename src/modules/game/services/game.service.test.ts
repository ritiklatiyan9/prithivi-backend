import { describe, expect, it, vi } from "vitest";
import { LudoRealtimeHub } from "../../ludo/sockets/ludo-hub.js";
import { GameService } from "./game.service.js";

const USER_A = "user-a";
const USER_B = "user-b";
const USER_C = "user-c";

const fakeSocket = () =>
  ({ readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() }) as never;

const makeHarness = () => {
  const created: Array<Record<string, any>> = [];
  let pausedLookup:
    | {
        userId: string;
        started: () => void;
        wait: Promise<void>;
      }
    | undefined;
  let pausedUpdate:
    | {
        started: () => void;
        wait: Promise<void>;
      }
    | undefined;

  const activeFor = (userId: string) =>
    created.find(
      (row) =>
        row.difficulty === "ONLINE" &&
        row.status === "IN_PROGRESS" &&
        (row.userId === userId || row.state?.oUserId === userId),
    ) ?? null;

  const prisma = {
    gameMatch: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, any> }) => {
        const userId = where.OR?.[0]?.userId as string;
        if (pausedLookup?.userId === userId) {
          const pause = pausedLookup;
          pausedLookup = undefined;
          pause.started();
          await pause.wait;
        }
        return activeFor(userId);
      }),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `match-${created.length + 1}`, status: "IN_PROGRESS", ...data };
        created.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (pausedUpdate) {
            const pause = pausedUpdate;
            pausedUpdate = undefined;
            pause.started();
            await pause.wait;
          }
          const row = created.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error("match not found");
          Object.assign(row, data);
          return row;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        created.find((row) => row.id === where.id) ?? null),
    },
    ludoEntitlement: { findUnique: vi.fn(async () => null) },
    user: {
      findMany: vi.fn(async () => [
        { id: USER_A, name: "A" },
        { id: USER_B, name: "B" },
        { id: USER_C, name: "C" },
      ]),
    },
  };
  const settings = {
    getBoolean: vi.fn(async () => true),
    getNumber: vi.fn(async () => 10),
    getString: vi.fn(async () => "MEDIUM"),
  };
  const hub = new LudoRealtimeHub();
  const sent: Array<{ userId: string; type: string }> = [];
  hub.send = ((userId: string, event: { type: string }) => {
    sent.push({ userId, type: event.type });
    return true;
  }) as typeof hub.send;
  const service = new GameService(
    prisma as never,
    settings as never,
    { enqueue: vi.fn() } as never,
    hub,
  );

  const pauseNextActiveLookup = (userId: string) => {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    pausedLookup = { userId, started, wait };
    return { didStart, release };
  };

  const pauseNextMatchUpdate = () => {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    pausedUpdate = { started, wait };
    return { didStart, release };
  };

  return {
    service,
    hub,
    sent,
    prisma,
    settings,
    created,
    pauseNextActiveLookup,
    pauseNextMatchUpdate,
  };
};

const connect = (hub: LudoRealtimeHub, userId: string) => {
  const socket = fakeSocket();
  hub.register({
    userId,
    socket,
    gameId: null,
    authenticatedAt: Date.now(),
    lastSeenAt: Date.now(),
  });
  return socket;
};

describe("joinOnlineMatchmaking", () => {
  it("pairs two connected users and sends both the match snapshot", async () => {
    const { service, hub, sent, created } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);

    await service.joinOnlineMatchmaking(USER_A);
    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.matchmaking.joined" });

    await service.joinOnlineMatchmaking(USER_B);
    expect(created).toHaveLength(1);
    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.match.found" });
    expect(sent).toContainEqual({ userId: USER_B, type: "ttt.match.found" });
  });

  it("keeps duplicate joins idempotent and rescans for an opponent", async () => {
    const { service, hub, sent, created } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);

    await service.joinOnlineMatchmaking(USER_A);
    await service.joinOnlineMatchmaking(USER_A);
    await service.joinOnlineMatchmaking(USER_B);

    expect(created).toHaveLength(1);
    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.match.found" });
    expect(sent).toContainEqual({ userId: USER_B, type: "ttt.match.found" });
  });

  it("serializes a reconnect while a queued opponent is being claimed", async () => {
    const { service, hub, created, pauseNextActiveLookup } = makeHarness();
    for (const userId of [USER_A, USER_B, USER_C]) connect(hub, userId);
    await service.joinOnlineMatchmaking(USER_A);

    const pause = pauseNextActiveLookup(USER_A);
    const joiningB = service.joinOnlineMatchmaking(USER_B);
    await pause.didStart;
    const reconnectingA = service.joinOnlineMatchmaking(USER_A);
    const joiningC = service.joinOnlineMatchmaking(USER_C);
    pause.release();

    await Promise.all([joiningB, reconnectingA, joiningC]);
    expect(created).toHaveLength(1);
    const state = created[0]!.state;
    expect([state.xUserId, state.oUserId]).toContain(USER_A);
  });

  it("requeues both players when match creation fails transiently", async () => {
    const { service, hub, prisma, created, sent } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);
    await service.joinOnlineMatchmaking(USER_A);
    prisma.gameMatch.create.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(service.joinOnlineMatchmaking(USER_B)).rejects.toThrow("database unavailable");
    await service.joinOnlineMatchmaking(USER_B);

    expect(created).toHaveLength(1);
    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.match.found" });
    expect(sent).toContainEqual({ userId: USER_B, type: "ttt.match.found" });
  });

  it("does not overwrite the realtime routing of an active Ludo room", async () => {
    const { service, hub, created } = makeHarness();
    connect(hub, USER_A);
    hub.setLudoGame(USER_A, "active-ludo-room");

    await expect(service.joinOnlineMatchmaking(USER_A)).rejects.toThrow(
      "Finish your current realtime game",
    );
    expect(created).toHaveLength(0);
    expect(hub.session(USER_A)?.ludoGameId).toBe("active-ludo-room");
    expect(hub.session(USER_A)?.gameId).toBeNull();
  });

  it("does not restore a stale Tic-tac-toe screen over an active Ludo route", async () => {
    const { service, hub, created } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);
    await service.joinOnlineMatchmaking(USER_A);
    await service.joinOnlineMatchmaking(USER_B);
    const matchId = created[0]!.id as string;
    hub.setGame(USER_A, null);
    hub.setLudoGame(USER_A, "active-ludo-room");

    await expect(service.sendOnlineState(USER_A, matchId)).rejects.toThrow(
      "Finish your current realtime game",
    );
    expect(hub.session(USER_A)?.ludoGameId).toBe("active-ludo-room");
    expect(hub.session(USER_A)?.gameId).toBeNull();
  });

  it("clears realtime routing when recovery finds a finished match", async () => {
    const { service, hub, created } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);
    await service.joinOnlineMatchmaking(USER_A);
    await service.joinOnlineMatchmaking(USER_B);
    const matchId = created[0]!.id as string;
    created[0]!.status = "DRAW";

    await service.sendOnlineState(USER_A, matchId);

    expect(hub.session(USER_A)?.gameId).toBeNull();
  });

  it("resumes an active match even after the daily limit is reached", async () => {
    const { service, hub, prisma, sent } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);
    await service.joinOnlineMatchmaking(USER_A);
    await service.joinOnlineMatchmaking(USER_B);
    sent.length = 0;
    prisma.gameMatch.count.mockResolvedValue(10);

    await service.joinOnlineMatchmaking(USER_A);

    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.match.found" });
  });

  it("does not let stale socket cleanup cancel a replacement session", async () => {
    const { service, hub, sent, pauseNextActiveLookup } = makeHarness();
    const oldSocket = connect(hub, USER_A);
    connect(hub, USER_C);
    await service.joinOnlineMatchmaking(USER_A);

    const pause = pauseNextActiveLookup(USER_C);
    const joiningC = service.joinOnlineMatchmaking(USER_C);
    await pause.didStart;
    hub.unregister(USER_A, oldSocket);
    const staleCleanup = service.disconnectOnline(USER_A);
    connect(hub, USER_A);
    const replacementJoin = service.joinOnlineMatchmaking(USER_A);
    pause.release();

    await Promise.all([joiningC, staleCleanup, replacementJoin]);
    expect(sent).not.toContainEqual({ userId: USER_A, type: "ttt.matchmaking.left" });
    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.match.found" });
  });

  it("finishes a match claimed at the same moment the queued user cancels", async () => {
    const { service, hub, sent, created, pauseNextActiveLookup } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);
    await service.joinOnlineMatchmaking(USER_A);

    const pause = pauseNextActiveLookup(USER_A);
    const joiningB = service.joinOnlineMatchmaking(USER_B);
    await pause.didStart;
    const leavingA = service.leaveOnlineMatchmaking(USER_A);
    pause.release();
    await Promise.all([joiningB, leavingA]);

    expect(created).toHaveLength(1);
    expect(created[0]!.status).not.toBe("IN_PROGRESS");
    expect(sent).toContainEqual({ userId: USER_B, type: "ttt.match.finished" });
  });

  it("serializes simultaneous leaves so only one authoritative winner is broadcast", async () => {
    const { service, hub, sent, created, pauseNextMatchUpdate } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);
    await service.joinOnlineMatchmaking(USER_A);
    await service.joinOnlineMatchmaking(USER_B);
    const matchId = created[0]!.id as string;
    sent.length = 0;

    const pause = pauseNextMatchUpdate();
    const firstLeave = service.leaveOnlineMatch(USER_A, matchId);
    await pause.didStart;
    const secondLeave = service.leaveOnlineMatch(USER_B, matchId);
    pause.release();
    await Promise.all([firstLeave, secondLeave]);

    expect(sent.filter((event) => event.type === "ttt.match.finished")).toHaveLength(2);
    expect(created[0]!.state.version).toBe(2);
  });
});
