import { z } from "zod";
import type { User } from "@prisma/client";
import { UPI_VPA_MESSAGE, UPI_VPA_REGEX } from "../../../common/upi.js";

export const publicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]),
  isActive: z.boolean(),
  referralCode: z.string().nullable(),
  hasAppliedReferral: z.boolean(),
  upiId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export type PublicUser = z.infer<typeof publicUserSchema>;

export const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarUrl: user.avatarUrl,
  role: user.role,
  isActive: user.isActive,
  referralCode: user.referralCode,
  hasAppliedReferral: user.referredById !== null,
  upiId: user.upiId,
  createdAt: user.createdAt.toISOString(),
});

export interface ProgressDto {
  coins: number; // lifetime coins earned (sum of wallet CREDITs)
  level: number;
  coinsInLevel: number;
  coinsForLevel: number; // 0 = max level reached (table mode past last threshold)
  rank: string;
  nextRank: string | null;
}

export const updateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  avatarUrl: z.string().url().nullable().optional(),
  /** Saved UPI VPA for coin payouts; null clears it. */
  upiId: z.string().trim().regex(UPI_VPA_REGEX, UPI_VPA_MESSAGE).nullable().optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const applyReferralSchema = z.object({
  code: z.string().trim().min(1).max(16),
});
export type ApplyReferralInput = z.infer<typeof applyReferralSchema>;
