import { describe, expect, it } from "vitest";
import { buildSocketAuthenticatedEvent } from "./ludo-gateway.js";
import { LudoRealtimeHub } from "./ludo-hub.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const GAME_ID = "22222222-2222-4222-8222-222222222222";

describe("Ludo socket authentication protocol", () => {
  it("returns both active-game field names and authoritative envelope metadata", () => {
    const hub = new LudoRealtimeHub();
    const recoveryEvent = hub.event("game.state", { snapshot: {} }, GAME_ID, 12);

    const event = buildSocketAuthenticatedEvent(hub, USER_ID, {
      gameId: GAME_ID,
      resumeToken: "rotated-resume-token",
      event: recoveryEvent,
    });

    expect(event).toMatchObject({
      type: "socket.authenticated",
      gameId: GAME_ID,
      stateVersion: 12,
      payload: {
        userId: USER_ID,
        activeGameId: GAME_ID,
        gameId: GAME_ID,
        resumeToken: "rotated-resume-token",
      },
    });
  });

  it("uses explicit nulls when there is no room to recover", () => {
    const event = buildSocketAuthenticatedEvent(new LudoRealtimeHub(), USER_ID, null);

    expect(event).toMatchObject({
      gameId: null,
      stateVersion: null,
      payload: { activeGameId: null, gameId: null, resumeToken: null },
    });
  });
});
