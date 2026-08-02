import { z } from "zod";
import type { Mission, MissionCompletion } from "@prisma/client";

export const missionStatusSchema = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
export const completionStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED"]);

// ---- DTOs ----

export interface MissionDto {
  id: string;
  title: string;
  description: string;
  rewardCoins: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const toMissionDto = (mission: Mission): MissionDto => ({
  id: mission.id,
  title: mission.title,
  description: mission.description,
  rewardCoins: mission.rewardCoins.toNumber(),
  status: mission.status,
  sortOrder: mission.sortOrder,
  createdAt: mission.createdAt.toISOString(),
  updatedAt: mission.updatedAt.toISOString(),
});

/** Published mission with the caller's completion status merged in. */
export interface UserMissionDto extends MissionDto {
  myCompletionStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
}

export type CompletionWithRelations = MissionCompletion & {
  mission: Pick<Mission, "title" | "rewardCoins">;
  user: { email: string };
};

export interface CompletionDto {
  id: string;
  missionId: string;
  missionTitle: string;
  rewardCoins: number;
  userId: string;
  userEmail: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  note: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export const toCompletionDto = (completion: CompletionWithRelations): CompletionDto => ({
  id: completion.id,
  missionId: completion.missionId,
  missionTitle: completion.mission.title,
  rewardCoins: completion.mission.rewardCoins.toNumber(),
  userId: completion.userId,
  userEmail: completion.user.email,
  status: completion.status,
  note: completion.note,
  reviewedById: completion.reviewedById,
  reviewedAt: completion.reviewedAt?.toISOString() ?? null,
  createdAt: completion.createdAt.toISOString(),
});

// ---- inputs ----

export const missionIdParamsSchema = z.object({
  id: z.string().uuid(),
});
export type MissionIdParams = z.infer<typeof missionIdParamsSchema>;

export const upsertMissionSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  rewardCoins: z.number().min(0).max(1_000_000),
  status: missionStatusSchema.default("DRAFT"),
  sortOrder: z.number().int().default(0),
});
export type UpsertMissionInput = z.infer<typeof upsertMissionSchema>;

export const updateMissionSchema = upsertMissionSchema.partial();
export type UpdateMissionInput = z.infer<typeof updateMissionSchema>;

export const listCompletionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: completionStatusSchema.optional(),
});
export type ListCompletionsQuery = z.infer<typeof listCompletionsQuerySchema>;

export const reviewCompletionSchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  note: z.string().max(2000).optional(),
});
export type ReviewCompletionInput = z.infer<typeof reviewCompletionSchema>;
