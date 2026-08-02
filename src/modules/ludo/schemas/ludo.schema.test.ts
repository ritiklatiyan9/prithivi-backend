import { describe, expect, it } from "vitest";
import { clientEventSchema, SERVER_EVENT_TYPES } from "./ludo.schema.js";

const base = {
  actionId: "action-123",
  gameId: "11111111-1111-4111-8111-111111111111",
  timestamp: "2026-08-02T12:00:00.000Z",
};

describe("Tic-tac-toe realtime protocol", () => {
  it.each([
    { type: "ttt.matchmaking.join", payload: {} },
    { type: "ttt.matchmaking.leave", payload: {} },
    { type: "ttt.state.request", payload: {} },
    { type: "ttt.move", payload: { cell: 4 } },
    { type: "ttt.match.leave", payload: {} },
    { type: "ttt.chat.quick.send", payload: { message: "GOOD_MOVE" } },
    { type: "ttt.chat.text.send", payload: { message: "Nice move" } },
    { type: "ttt.voice.session.join", payload: {} },
    {
      type: "ttt.voice.offer",
      payload: {
        targetUserId: "22222222-2222-4222-8222-222222222222",
        sdp: "offer-sdp",
      },
    },
    {
      type: "ttt.voice.ice_candidate",
      payload: {
        targetUserId: "22222222-2222-4222-8222-222222222222",
        candidate: "candidate-value",
      },
    },
  ])("accepts $type", (event) => {
    expect(clientEventSchema.safeParse({ ...base, ...event }).success).toBe(true);
  });

  it("publishes the online match event types", () => {
    expect(SERVER_EVENT_TYPES).toEqual(
      expect.arrayContaining([
        "ttt.matchmaking.joined",
        "ttt.match.found",
        "ttt.match.updated",
        "ttt.match.finished",
        "ttt.chat.received",
      ]),
    );
  });
});
