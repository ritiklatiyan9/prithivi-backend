import { z } from "zod";

export const adminStatsSchema = z.object({
  totalUsers: z.number(),
  activeCampaigns: z.number(),
  pendingClaims: z.number(),
  approvedClaims: z.number(),
  totalWalletBalance: z.number(),
  // Live-economy review queues + referral reach:
  pendingSubmissions: z.number(),
  pendingRedemptions: z.number(),
  coinsInPendingRedemptions: z.number(),
  fulfilledRedemptions: z.number(),
  pendingMissionCompletions: z.number(),
  totalReferrals: z.number(),
});
export type AdminStats = z.infer<typeof adminStatsSchema>;

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
  role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const listReferralsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListReferralsQuery = z.infer<typeof listReferralsQuerySchema>;

export interface AdminReferralRow {
  referred: { id: string; name: string; email: string; referredAt: string | null };
  referrer: { id: string; name: string; email: string; referralCode: string | null } | null;
  creditedPoints: number | null;
  inviteeCreditedPoints: number;
}

export const userIdParamsSchema = z.object({
  id: z.string().uuid(),
});
export type UserIdParams = z.infer<typeof userIdParamsSchema>;

export const updateUserRoleSchema = z.object({
  role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]),
});
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;

export const updateUserStatusSchema = z.object({
  isActive: z.boolean(),
});
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;
