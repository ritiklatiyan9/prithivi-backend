import { describe, expect, it, vi } from "vitest";
import { LudoRealtimeHub } from "./ludo-hub.js";

const socket = () =>
  ({
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
  }) as never;

describe("LudoRealtimeHub room routing", () => {
  it("keeps Ludo and Tic-tac-toe routing independent on one socket", () => {
    const hub = new LudoRealtimeHub();
    const client = socket() as any;
    hub.register({
      userId: "user-a",
      socket: client,
      gameId: null,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    hub.setLudoGame("user-a", "ludo-room");
    hub.setGame("user-a", "ttt-match");
    hub.broadcastLudoRoom("ludo-room", hub.event("chat.typing", {}));
    hub.broadcastRoom("ttt-match", hub.event("ttt.match.updated", {}));

    expect(hub.session("user-a")).toMatchObject({
      gameId: "ttt-match",
      ludoGameId: "ludo-room",
    });
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("closes a slow consumer instead of growing an unbounded send buffer", () => {
    const hub = new LudoRealtimeHub();
    const client = socket() as any;
    client.bufferedAmount = 1024 * 1024 + 1;
    hub.register({
      userId: "user-a",
      socket: client,
      gameId: null,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    expect(hub.send("user-a", hub.event("socket.pong", {}))).toBe(false);
    expect(client.send).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledWith(1013, "Realtime client is too slow");
    expect(hub.metrics().errors).toBe(1);
  });
});
