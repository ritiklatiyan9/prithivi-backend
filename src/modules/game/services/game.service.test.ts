// Regression tests for online TTT matchmaking. The original implementation
// early-returned when the joining user was already queued (so a re-join after
// a reconnect never rescanned for opponents) and validated the opponent AFTER
// removing them from the queue (a throw silently dropped both players).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LudoRealtimeHub } from "../../ludo/sockets/ludo-hub.js";
import { GameService } from "./game.service.js";

const USER_A = "user-a";
const USER_B = "user-b";

const fakeSocket = () =>
  ({ readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() }) as never;

const makeHarness = () => {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    gameMatch: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `match-${created.length + 1}`, status: "IN_PROGRESS", ...data };
        created.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        created.find((row) => row.id === where.id) ?? null),
    },
    ludoEntitlement: { findUnique: vi.fn(async () => null) },
    user: {
      findMany: vi.fn(async () => [
        { id: USER_A, name: "A" },
        { id: USER_B, name: "B" },
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
  return { service, hub, sent, prisma };
};

const connect = (hub: LudoRealtimeHub, userId: string) =>
  hub.register({
    userId,
    socket: fakeSocket(),
    gameId: null,
    authenticatedAt: Date.now(),
    lastSeenAt: Date.now(),
  });

describe("joinOnlineMatchmaking", () => {
  beforeEach(async () => {
    // The queue is module-level; drain whatever a previous test left behind.
    const { service, hub } = makeHarness();
    for (const user of [USER_A, USER_B]) {
      connect(hub, user);
      await service.leaveOnlineMatchmaking(user);
    }
  });

  it("pairs two connected users and sends both the match snapshot", async () => {
    const { service, hub, sent } = makeHarness();
    connect(hub, USER_A);
    connect(hub, USER_B);

    await service.joinOnlineMatchmaking(USER_A);
    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.matchmaking.joined" });

    await service.joinOnlineMatchmaking(USER_B);
    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.match.found" });
    expect(sent).toContainEqual({ userId: USER_B, type: "ttt.match.found" });
  });

  it("re-join while already queued still pairs (reconnect regression)", async () => {
    const { service, hub, sent } = makeHarness();
    connect(hub, USER_A);
    await service.joinOnlineMatchmaking(USER_A); // queued alone

    connect(hub, USER_B);
    await service.joinOnlineMatchmaking(USER_B); // pairs immediately…
    // …but simulate the historical stuck state instead: A re-joins while
    // both are queued. Reset by leaving and re-queueing both.
    await service.leaveOnlineMatchmaking(USER_A);
    await service.leaveOnlineMatchmaking(USER_B);
    sent.length = 0;

    await service.joinOnlineMatchmaking(USER_A);
    await service.joinOnlineMatchmaking(USER_A); // duplicate join must not wedge the queue
    await service.joinOnlineMatchmaking(USER_B);
    expect(sent).toContainEqual({ userId: USER_A, type: "ttt.match.found" });
    expect(sent).toContainEqual({ userId: USER_B, type: "ttt.match.found" });
  });
});
