import type { Prisma } from "@prisma/client";
import { SETTINGS_BY_KEY } from "../../settings/schemas/settings.schema.js";

export interface ReferralPolicy {
  enabled: boolean;
  rewardPoints: number;
  inviteeRewardPoints: number;
}

// Rewards are read fresh, together, from the database. An admin change must
// not wait for another API worker's settings cache to expire.
export async function readReferralPolicy(
  db: Pick<Prisma.TransactionClient, "setting">,
): Promise<ReferralPolicy> {
  const rows = await db.setting.findMany({
    where: {
      key: { in: ["referral.enabled", "referral.rewardPoints", "referral.inviteeRewardPoints"] },
    },
    select: { key: true, value: true },
  });
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const amount = (key: string): number => {
    const definition = SETTINGS_BY_KEY[key];
    const raw = values.get(key) ?? definition.default;
    const value = Number(raw);
    return raw.trim() !== "" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
      ? value
      : Number(definition.default);
  };
  return {
    enabled: (values.get("referral.enabled") ?? "true") === "true",
    rewardPoints: amount("referral.rewardPoints"),
    inviteeRewardPoints: amount("referral.inviteeRewardPoints"),
  };
}
