import { describe, expect, it } from "vitest";
import {
  HOME,
  SAFE_GLOBAL_CELLS,
  YARD,
  applyMove,
  applyRoll,
  createInitialState,
  expireTurn,
  forfeitPlayer,
  globalCellFor,
  legalPawnIndices,
  startGame,
  type LudoEngineState,
} from "./ludo.js";

const now = "2026-08-02T00:00:00.000Z";

const game = (mode: "TWO_PLAYER" | "THREE_PLAYER" | "FOUR_PLAYER" = "TWO_PLAYER"): LudoEngineState =>
  startGame(
    createInitialState({
      gameId: "game-1",
      mode,
      userIds:
        mode === "TWO_PLAYER"
          ? ["red", "yellow"]
          : mode === "THREE_PLAYER"
            ? ["red", "blue", "yellow"]
            : ["red", "blue", "yellow", "green"],
      now,
    }),
    now,
  );

describe("Ludo initialization and board mapping", () => {
  it("creates opposite colours for two players and four pawns in the yard", () => {
    const state = game();
    expect(state.players.map((player) => player.color)).toEqual(["RED", "YELLOW"]);
    expect(state.players.every((player) => player.pawns.every((pawn) => pawn === YARD))).toBe(true);
    expect(state.phase).toBe("AWAITING_ROLL");
  });

  it("creates all four colours in canonical seat order", () => {
    expect(game("FOUR_PLAYER").players.map((player) => player.color)).toEqual([
      "RED",
      "BLUE",
      "YELLOW",
      "GREEN",
    ]);
  });

  it("creates red, blue and yellow seats for three-player matches", () => {
    expect(game("THREE_PLAYER").players.map((player) => player.color)).toEqual([
      "RED",
      "BLUE",
      "YELLOW",
    ]);
  });

  it("maps each relative start to its global safe start cell", () => {
    for (const color of ["RED", "GREEN", "YELLOW", "BLUE"] as const) {
      expect(SAFE_GLOBAL_CELLS.has(globalCellFor(color, 0)!)).toBe(true);
      expect(globalCellFor(color, 52)).toBeNull();
      expect(globalCellFor(color, YARD)).toBeNull();
    }
  });

  it("keeps equal server cells equal after the client's constant visual rotation", () => {
    const visualIndex = (global: number): number => (global + 36) % 52;
    const redGlobal = globalCellFor("RED", 13)!;
    const blueGlobal = globalCellFor("BLUE", 0)!;
    expect(redGlobal).toBe(blueGlobal);
    expect(visualIndex(redGlobal)).toBe(visualIndex(blueGlobal));
    expect([
      visualIndex(globalCellFor("RED", 0)!),
      visualIndex(globalCellFor("BLUE", 0)!),
      visualIndex(globalCellFor("YELLOW", 0)!),
      visualIndex(globalCellFor("GREEN", 0)!),
    ]).toEqual([36, 49, 10, 23]);
  });

  it("rejects duplicate players and the wrong mode cardinality", () => {
    expect(() =>
      createInitialState({ gameId: "x", mode: "TWO_PLAYER", userIds: ["a", "a"] }),
    ).toThrow("unique");
    expect(() =>
      createInitialState({ gameId: "x", mode: "FOUR_PLAYER", userIds: ["a", "b"] }),
    ).toThrow("exactly 4");
    expect(() =>
      createInitialState({ gameId: "x", mode: "THREE_PLAYER", userIds: ["a", "b"] }),
    ).toThrow("exactly 3");
  });
});

describe("legal movement", () => {
  it("requires a six to leave the yard", () => {
    const player = game().players[0];
    expect(legalPawnIndices(player, 5)).toEqual([]);
    expect(legalPawnIndices(player, 6)).toEqual([0, 1, 2, 3]);
  });

  it("moves a yard pawn onto progress zero, not six", () => {
    const rolled = applyRoll(game(), "red", 6, now);
    const moved = applyMove(rolled.state, "red", 2, now);
    expect(moved.from).toBe(YARD);
    expect(moved.to).toBe(0);
    expect(moved.path).toEqual([0]);
    expect(moved.state.players[0].pawns[2]).toBe(0);
  });

  it("requires an exact roll to reach home", () => {
    const state = game();
    state.players[0].pawns = [56, HOME, HOME, HOME];
    expect(legalPawnIndices(state.players[0], 1)).toEqual([0]);
    expect(legalPawnIndices(state.players[0], 2)).toEqual([]);
  });

  it("does not mutate the caller's state", () => {
    const state = game();
    const rolled = applyRoll(state, "red", 6, now);
    expect(state.dice).toBeNull();
    expect(state.players[0].pawns).toEqual([YARD, YARD, YARD, YARD]);
    applyMove(rolled.state, "red", 0, now);
    expect(rolled.state.players[0].pawns[0]).toBe(YARD);
  });

  it("rejects out-of-turn and illegal pawn requests", () => {
    expect(() => applyRoll(game(), "yellow", 6, now)).toThrow("not this player's turn");
    const rolled = applyRoll(game(), "red", 6, now);
    expect(() => applyMove(rolled.state, "red", 9, now)).toThrow("not legal");
  });
});

describe("turn and six rules", () => {
  it("keeps the turn after a six and changes it after a normal move", () => {
    let state = game();
    let roll = applyRoll(state, "red", 6, now);
    state = applyMove(roll.state, "red", 0, now).state;
    expect(state.currentTurnSeat).toBe(0);
    expect(state.phase).toBe("AWAITING_ROLL");

    roll = applyRoll(state, "red", 2, now);
    state = applyMove(roll.state, "red", 0, now).state;
    expect(state.currentTurnSeat).toBe(1);
    expect(state.consecutiveSixes).toBe(0);
  });

  it("grants another roll for a six even when no pawn can move", () => {
    const state = game();
    state.players[0].pawns = [HOME, HOME, HOME, HOME];
    state.players[0].status = "ACTIVE";
    const outcome = applyRoll(state, "red", 6, now);
    expect(outcome.legalPawnIds).toEqual([]);
    expect(outcome.state.currentTurnSeat).toBe(0);
    expect(outcome.state.phase).toBe("AWAITING_ROLL");
  });

  it("ends the turn immediately on a configured third consecutive six", () => {
    const state = game();
    state.players[0].pawns[0] = 3;
    state.consecutiveSixes = 2;
    const outcome = applyRoll(state, "red", 6, now);
    expect(outcome.thirdSixForfeit).toBe(true);
    expect(outcome.state.players[0].pawns[0]).toBe(3);
    expect(outcome.state.currentTurnSeat).toBe(1);
    expect(outcome.state.dice).toBeNull();
  });

  it("allows a third six when the rule is disabled", () => {
    const state = game();
    state.config.threeConsecutiveSixes = false;
    state.consecutiveSixes = 2;
    const outcome = applyRoll(state, "red", 6, now);
    expect(outcome.thirdSixForfeit).toBe(false);
    expect(outcome.state.phase).toBe("AWAITING_MOVE");
  });

  it("server expiry clears a pending roll/move and advances the turn", () => {
    const rolled = applyRoll(game(), "red", 6, now).state;
    const expired = expireTurn(rolled, now);
    expect(expired.currentTurnSeat).toBe(1);
    expect(expired.phase).toBe("AWAITING_ROLL");
    expect(expired.dice).toBeNull();
  });
});

describe("captures and safe cells", () => {
  it("captures every opponent pawn on a non-safe destination and grants an extra turn", () => {
    const state = game();
    state.players[0].pawns[0] = 3; // red global 3, roll 2 -> global 5
    state.players[1].pawns = [31, 31, YARD, YARD]; // yellow offset 26 => global 5
    const rolled = applyRoll(state, "red", 2, now);
    const moved = applyMove(rolled.state, "red", 0, now);
    expect(moved.captured).toEqual([
      { userId: "yellow", pawnIndex: 0 },
      { userId: "yellow", pawnIndex: 1 },
    ]);
    expect(moved.state.players[1].pawns.slice(0, 2)).toEqual([YARD, YARD]);
    expect(moved.extraTurn).toBe(true);
    expect(moved.state.currentTurnSeat).toBe(0);
  });

  it("never captures on a safe cell", () => {
    const state = game();
    state.players[0].pawns[0] = 6; // roll 2 -> red global safe 8
    state.players[1].pawns[0] = 34; // yellow global 8
    const moved = applyMove(applyRoll(state, "red", 2, now).state, "red", 0, now);
    expect(moved.captured).toEqual([]);
    expect(moved.state.players[1].pawns[0]).toBe(34);
  });
});

describe("finishing and forfeits", () => {
  it("finishes a two-player match when the first player homes every pawn", () => {
    const state = game();
    state.players[0].pawns = [56, HOME, HOME, HOME];
    const moved = applyMove(applyRoll(state, "red", 1, now).state, "red", 0, now);
    expect(moved.playerFinished).toBe(true);
    expect(moved.reachedHome).toBe(true);
    expect(moved.state.status).toBe("COMPLETED");
    expect(moved.state.finishOrder).toEqual(["red", "yellow"]);
    expect(moved.state.players.map((player) => player.finishedPosition)).toEqual([1, 2]);
  });

  it("continues a four-player match after the first finisher", () => {
    const state = game("FOUR_PLAYER");
    state.players[0].pawns = [56, HOME, HOME, HOME];
    const moved = applyMove(applyRoll(state, "red", 1, now).state, "red", 0, now);
    expect(moved.state.status).toBe("ACTIVE");
    expect(moved.state.finishOrder).toEqual(["red"]);
    expect(moved.state.currentTurnSeat).toBe(1);
  });

  it("awards the survivor first place after an opponent forfeits", () => {
    const state = forfeitPlayer(game(), "red", now);
    expect(state.status).toBe("COMPLETED");
    expect(state.finishOrder).toEqual(["yellow", "red"]);
    expect(state.players.find((player) => player.userId === "red")?.status).toBe("FORFEITED");
  });

  it("skips a non-current forfeiter without disrupting the current turn", () => {
    const pendingMove = applyRoll(game("FOUR_PLAYER"), "red", 6, now).state;
    const state = forfeitPlayer(pendingMove, "yellow", now);
    expect(state.status).toBe("ACTIVE");
    expect(state.currentTurnSeat).toBe(0);
    expect(state.players[2].status).toBe("FORFEITED");
    expect(state.phase).toBe("AWAITING_MOVE");
    expect(state.dice).toBe(6);
    expect(state.legalPawnIds).toEqual([0, 1, 2, 3]);
  });

  it("advances when the current player forfeits", () => {
    const state = forfeitPlayer(game("FOUR_PLAYER"), "red", now);
    expect(state.currentTurnSeat).toBe(1);
    expect(state.phase).toBe("AWAITING_ROLL");
  });
});
