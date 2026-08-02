/**
 * Pure, deterministic Indian Ludo rules engine.
 *
 * Pawn progress is relative to its owner's route:
 *   -1       yard
 *    0..51   shared outer track (0 is that colour's start)
 *   52..56   coloured home lane
 *   57       home
 *
 * Randomness, persistence, clocks and authorization deliberately live outside
 * this file. A caller supplies the dice value and receives a new immutable
 * state plus an outcome suitable for an authoritative event.
 */

export type LudoMode = "TWO_PLAYER" | "THREE_PLAYER" | "FOUR_PLAYER";
export type LudoColor = "RED" | "GREEN" | "YELLOW" | "BLUE";
export type EnginePlayerStatus = "ACTIVE" | "FINISHED" | "FORFEITED";
export type LudoPhase = "AWAITING_ROLL" | "AWAITING_MOVE" | "COMPLETED";

export interface LudoEngineConfig {
  pawnsPerPlayer: number;
  threeConsecutiveSixes: boolean;
  extraTurnOnSix: boolean;
  extraTurnOnCapture: boolean;
}

export interface LudoEnginePlayer {
  userId: string;
  seat: number;
  color: LudoColor;
  pawns: number[];
  status: EnginePlayerStatus;
  finishedPosition: number | null;
}

export interface LudoEngineState {
  gameId: string;
  mode: LudoMode;
  status: "WAITING" | "ACTIVE" | "COMPLETED";
  phase: LudoPhase;
  currentTurnSeat: number;
  turnNumber: number;
  consecutiveSixes: number;
  dice: number | null;
  legalPawnIds: number[];
  players: LudoEnginePlayer[];
  finishOrder: string[];
  forfeitOrder: string[];
  config: LudoEngineConfig;
  lastActionAt: string;
}

export interface RollOutcome {
  state: LudoEngineState;
  dice: number;
  legalPawnIds: number[];
  thirdSixForfeit: boolean;
  turnChanged: boolean;
}

export interface MoveOutcome {
  state: LudoEngineState;
  pawnIndex: number;
  from: number;
  to: number;
  path: number[];
  captured: Array<{ userId: string; pawnIndex: number }>;
  reachedHome: boolean;
  playerFinished: boolean;
  extraTurn: boolean;
  turnChanged: boolean;
}

export const YARD = -1;
export const HOME = 57;
export const OUTER_TRACK_LAST = 51;

export const START_OFFSETS: Record<LudoColor, number> = {
  RED: 0,
  BLUE: 13,
  YELLOW: 26,
  GREEN: 39,
};

/** Starts plus the four star cells. Captures can never occur here. */
export const SAFE_GLOBAL_CELLS: ReadonlySet<number> = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export const DEFAULT_ENGINE_CONFIG: LudoEngineConfig = {
  pawnsPerPlayer: 4,
  threeConsecutiveSixes: true,
  extraTurnOnSix: true,
  extraTurnOnCapture: true,
};

const COLORS_BY_MODE: Record<LudoMode, readonly LudoColor[]> = {
  TWO_PLAYER: ["RED", "YELLOW"],
  THREE_PLAYER: ["RED", "BLUE", "YELLOW"],
  FOUR_PLAYER: ["RED", "BLUE", "YELLOW", "GREEN"],
};

const copyState = (state: LudoEngineState): LudoEngineState => ({
  ...state,
  legalPawnIds: [...state.legalPawnIds],
  finishOrder: [...state.finishOrder],
  forfeitOrder: [...state.forfeitOrder],
  config: { ...state.config },
  players: state.players.map((player) => ({ ...player, pawns: [...player.pawns] })),
});

const assertDice = (dice: number): void => {
  if (!Number.isInteger(dice) || dice < 1 || dice > 6) {
    throw new Error("Dice must be an integer from 1 to 6");
  }
};

const currentPlayer = (state: LudoEngineState): LudoEnginePlayer => {
  const player = state.players.find((candidate) => candidate.seat === state.currentTurnSeat);
  if (!player || player.status !== "ACTIVE") throw new Error("Current player is not active");
  return player;
};

export const globalCellFor = (color: LudoColor, progress: number): number | null => {
  if (progress < 0 || progress > OUTER_TRACK_LAST) return null;
  return (START_OFFSETS[color] + progress) % 52;
};

export const legalPawnIndices = (player: LudoEnginePlayer, dice: number): number[] => {
  assertDice(dice);
  const legal: number[] = [];
  player.pawns.forEach((progress, index) => {
    if (progress === HOME) return;
    if (progress === YARD) {
      if (dice === 6) legal.push(index);
      return;
    }
    if (progress + dice <= HOME) legal.push(index);
  });
  return legal;
};

const nextActiveSeat = (state: LudoEngineState, afterSeat: number): number | null => {
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const seat = (afterSeat + offset) % state.players.length;
    if (state.players.find((player) => player.seat === seat)?.status === "ACTIVE") return seat;
  }
  return null;
};

const beginRoll = (state: LudoEngineState, seat: number, resetSixes: boolean): void => {
  state.currentTurnSeat = seat;
  state.phase = "AWAITING_ROLL";
  state.dice = null;
  state.legalPawnIds = [];
  state.turnNumber += 1;
  if (resetSixes) state.consecutiveSixes = 0;
};

const appendOnce = (items: string[], value: string): void => {
  if (!items.includes(value)) items.push(value);
};

/** Assign any remaining places and mark the game complete when at most one
 * active player remains. Forfeits rank after players who stayed in the game;
 * a later forfeit ranks ahead of an earlier one. */
const finalizeIfDecided = (state: LudoEngineState): boolean => {
  const active = state.players.filter((player) => player.status === "ACTIVE");
  if (active.length > 1) return false;

  if (active[0]) appendOnce(state.finishOrder, active[0].userId);
  for (const userId of [...state.forfeitOrder].reverse()) appendOnce(state.finishOrder, userId);
  for (const player of state.players) appendOnce(state.finishOrder, player.userId);
  state.finishOrder.forEach((userId, index) => {
    const player = state.players.find((candidate) => candidate.userId === userId);
    if (player) player.finishedPosition = index + 1;
  });
  state.status = "COMPLETED";
  state.phase = "COMPLETED";
  state.dice = null;
  state.legalPawnIds = [];
  return true;
};

export const createInitialState = (params: {
  gameId: string;
  mode: LudoMode;
  userIds: string[];
  now?: string;
  config?: Partial<LudoEngineConfig>;
  startingSeat?: number;
}): LudoEngineState => {
  const colors = COLORS_BY_MODE[params.mode];
  if (params.userIds.length !== colors.length) {
    throw new Error(`${params.mode} requires exactly ${colors.length} players`);
  }
  if (new Set(params.userIds).size !== params.userIds.length) {
    throw new Error("Player ids must be unique");
  }
  const config = { ...DEFAULT_ENGINE_CONFIG, ...params.config };
  if (!Number.isInteger(config.pawnsPerPlayer) || config.pawnsPerPlayer < 1 || config.pawnsPerPlayer > 4) {
    throw new Error("pawnsPerPlayer must be an integer from 1 to 4");
  }
  const startingSeat = params.startingSeat ?? 0;
  if (!Number.isInteger(startingSeat) || startingSeat < 0 || startingSeat >= colors.length) {
    throw new Error("Invalid starting seat");
  }
  return {
    gameId: params.gameId,
    mode: params.mode,
    status: "WAITING",
    phase: "AWAITING_ROLL",
    currentTurnSeat: startingSeat,
    turnNumber: 1,
    consecutiveSixes: 0,
    dice: null,
    legalPawnIds: [],
    players: params.userIds.map((userId, seat) => ({
      userId,
      seat,
      color: colors[seat],
      pawns: Array<number>(config.pawnsPerPlayer).fill(YARD),
      status: "ACTIVE",
      finishedPosition: null,
    })),
    finishOrder: [],
    forfeitOrder: [],
    config,
    lastActionAt: params.now ?? new Date(0).toISOString(),
  };
};

export const startGame = (input: LudoEngineState, now: string): LudoEngineState => {
  if (input.status !== "WAITING") throw new Error("Game cannot be started from this state");
  const state = copyState(input);
  state.status = "ACTIVE";
  state.lastActionAt = now;
  return state;
};

export const applyRoll = (
  input: LudoEngineState,
  userId: string,
  dice: number,
  now: string,
): RollOutcome => {
  assertDice(dice);
  if (input.status !== "ACTIVE" || input.phase !== "AWAITING_ROLL") {
    throw new Error("The game is not waiting for a dice roll");
  }
  const state = copyState(input);
  const player = currentPlayer(state);
  if (player.userId !== userId) throw new Error("It is not this player's turn");
  state.lastActionAt = now;
  state.consecutiveSixes = dice === 6 ? state.consecutiveSixes + 1 : 0;

  if (dice === 6 && state.config.threeConsecutiveSixes && state.consecutiveSixes >= 3) {
    const next = nextActiveSeat(state, player.seat);
    if (next === null) finalizeIfDecided(state);
    else beginRoll(state, next, true);
    return { state, dice, legalPawnIds: [], thirdSixForfeit: true, turnChanged: true };
  }

  const legal = legalPawnIndices(player, dice);
  state.dice = dice;
  state.legalPawnIds = legal;
  if (legal.length > 0) {
    state.phase = "AWAITING_MOVE";
    return { state, dice, legalPawnIds: legal, thirdSixForfeit: false, turnChanged: false };
  }

  if (dice === 6 && state.config.extraTurnOnSix) {
    beginRoll(state, player.seat, false);
    return { state, dice, legalPawnIds: [], thirdSixForfeit: false, turnChanged: false };
  }
  const next = nextActiveSeat(state, player.seat);
  if (next === null) finalizeIfDecided(state);
  else beginRoll(state, next, true);
  return { state, dice, legalPawnIds: [], thirdSixForfeit: false, turnChanged: true };
};

const movementPath = (from: number, dice: number): number[] => {
  if (from === YARD) return [0];
  return Array.from({ length: dice }, (_, index) => from + index + 1);
};

export const applyMove = (
  input: LudoEngineState,
  userId: string,
  pawnIndex: number,
  now: string,
): MoveOutcome => {
  if (input.status !== "ACTIVE" || input.phase !== "AWAITING_MOVE" || input.dice === null) {
    throw new Error("The game is not waiting for a pawn move");
  }
  const dice = input.dice;
  const state = copyState(input);
  const player = currentPlayer(state);
  if (player.userId !== userId) throw new Error("It is not this player's turn");
  if (!Number.isInteger(pawnIndex) || !state.legalPawnIds.includes(pawnIndex)) {
    throw new Error("Pawn is not legal for this roll");
  }

  const from = player.pawns[pawnIndex];
  const path = movementPath(from, dice);
  const to = from === YARD ? 0 : from + dice;
  player.pawns[pawnIndex] = to;
  state.lastActionAt = now;

  const captured: Array<{ userId: string; pawnIndex: number }> = [];
  const destination = globalCellFor(player.color, to);
  if (destination !== null && !SAFE_GLOBAL_CELLS.has(destination)) {
    for (const opponent of state.players) {
      if (opponent.userId === userId || opponent.status === "FORFEITED") continue;
      opponent.pawns.forEach((progress, index) => {
        if (globalCellFor(opponent.color, progress) === destination) {
          opponent.pawns[index] = YARD;
          captured.push({ userId: opponent.userId, pawnIndex: index });
        }
      });
    }
  }

  const reachedHome = to === HOME;
  const playerFinished = player.pawns.every((progress) => progress === HOME);
  if (playerFinished) {
    player.status = "FINISHED";
    appendOnce(state.finishOrder, player.userId);
    player.finishedPosition = state.finishOrder.length;
  }

  state.dice = null;
  state.legalPawnIds = [];
  if (finalizeIfDecided(state)) {
    return {
      state,
      pawnIndex,
      from,
      to,
      path,
      captured,
      reachedHome,
      playerFinished,
      extraTurn: false,
      turnChanged: true,
    };
  }

  const extraTurn =
    player.status === "ACTIVE" &&
    ((dice === 6 && state.config.extraTurnOnSix) ||
      (captured.length > 0 && state.config.extraTurnOnCapture));
  if (extraTurn) {
    beginRoll(state, player.seat, dice !== 6);
  } else {
    const next = nextActiveSeat(state, player.seat);
    if (next === null) finalizeIfDecided(state);
    else beginRoll(state, next, true);
  }

  return {
    state,
    pawnIndex,
    from,
    to,
    path,
    captured,
    reachedHome,
    playerFinished,
    extraTurn,
    turnChanged: !extraTurn,
  };
};

/** Server turn-timeout transition. The service separately counts strikes and
 * decides whether to call this or forfeitPlayer. */
export const expireTurn = (input: LudoEngineState, now: string): LudoEngineState => {
  if (input.status !== "ACTIVE") throw new Error("Game is not active");
  const state = copyState(input);
  const player = currentPlayer(state);
  const next = nextActiveSeat(state, player.seat);
  state.lastActionAt = now;
  if (next === null) finalizeIfDecided(state);
  else beginRoll(state, next, true);
  return state;
};

export const forfeitPlayer = (
  input: LudoEngineState,
  userId: string,
  now: string,
): LudoEngineState => {
  if (input.status !== "ACTIVE") throw new Error("Game is not active");
  const state = copyState(input);
  const player = state.players.find((candidate) => candidate.userId === userId);
  if (!player || player.status !== "ACTIVE") throw new Error("Player cannot forfeit");
  const wasCurrent = player.seat === state.currentTurnSeat;
  player.status = "FORFEITED";
  state.forfeitOrder.push(userId);
  state.lastActionAt = now;

  if (!finalizeIfDecided(state) && wasCurrent) {
    state.dice = null;
    state.legalPawnIds = [];
    const next = nextActiveSeat(state, player.seat);
    if (next !== null) beginRoll(state, next, true);
  }
  return state;
};

export const completedPawnCount = (player: LudoEnginePlayer): number =>
  player.pawns.filter((progress) => progress === HOME).length;
