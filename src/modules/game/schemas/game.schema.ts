import { z } from "zod";
import type { Cell, Difficulty } from "../engine/tictactoe.js";

export const matchIdParamsSchema = z.object({
  id: z.string().uuid(),
});
export type MatchIdParams = z.infer<typeof matchIdParamsSchema>;

export const moveSchema = z.object({
  cell: z.number().int().min(0).max(8),
});
export type MoveInput = z.infer<typeof moveSchema>;

// Body is optional — an empty/missing body means hints off.
export const startMatchSchema = z
  .object({ hints: z.boolean().default(false) })
  .default({ hints: false });
export type StartMatchInput = z.infer<typeof startMatchSchema>;

export type MatchStatus = "IN_PROGRESS" | "WON" | "LOST" | "DRAW";

export interface TttConfigDto {
  enabled: boolean;
  winCoins: number;
  hintWinCoins: number;
  difficulty: Difficulty;
  membershipPlan: "FREE" | "PLUS" | "PRO";
  textChatEnabled: boolean;
  voiceChatEnabled: boolean;
  dailyLimit: number;
  playedToday: number;
  remaining: number;
}

export interface StartMatchDto {
  matchId: string;
  board: Cell[];
  yourSymbol: "X";
  hintsEnabled: boolean;
}

export interface MoveResultDto {
  board: Cell[];
  removedCell: number | null;
  aiMove: number | null;
  aiRemovedCell: number | null;
  status: MatchStatus;
  coinsAwarded: number | null;
}
