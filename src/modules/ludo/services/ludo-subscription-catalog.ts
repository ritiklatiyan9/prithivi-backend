import type { Env } from "../../../config/env.js";

export type LudoPaidPlanCode = "PLUS" | "PRO";
export type LudoPlanAvailabilityReason = "PAYMENT_NOT_CONFIGURED";

export interface LudoCatalogPlan {
  plan: "FREE" | LudoPaidPlanCode;
  code: "FREE" | LudoPaidPlanCode;
  defaultName: string;
  pricePaise: number;
  period: "MONTHLY";
  features: readonly string[];
  entitlements: {
    quickChat: true;
    textChat: boolean;
    voiceChat: boolean;
  };
}

export const LUDO_SUBSCRIPTION_CATALOG: readonly LudoCatalogPlan[] = [
  {
    plan: "FREE",
    code: "FREE",
    defaultName: "Free",
    pricePaise: 0,
    period: "MONTHLY",
    features: ["Quick chat", "Free reactions"],
    entitlements: { quickChat: true, textChat: false, voiceChat: false },
  },
  {
    plan: "PLUS",
    code: "PLUS",
    defaultName: "Ludo Plus",
    pricePaise: 9_900,
    period: "MONTHLY",
    features: ["Quick chat", "Text chat"],
    entitlements: { quickChat: true, textChat: true, voiceChat: false },
  },
  {
    plan: "PRO",
    code: "PRO",
    defaultName: "Ludo Pro",
    pricePaise: 14_900,
    period: "MONTHLY",
    features: ["Quick chat", "Text chat", "Voice chat"],
    entitlements: { quickChat: true, textChat: true, voiceChat: true },
  },
] as const;

const PLACEHOLDER_VALUE = /(?:change[_ -]?me|replace[_ -]?me|your[_ -]?)/i;

/**
 * Environment values from deployment templates are not real configuration.
 * Treat blank/placeholder values as absent so checkout cannot charge a user
 * when webhook-driven entitlement activation is unable to complete.
 */
export const configuredValue = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && !PLACEHOLDER_VALUE.test(trimmed) ? trimmed : null;
};

export interface RazorpayCredentialOverrides {
  keyId?: string;
  keySecret?: string;
}

export const razorpayCredentials = (
  env: Pick<Env, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET">,
  overrides: RazorpayCredentialOverrides = {},
): { keyId: string; keySecret: string } | null => {
  const keyId = configuredValue(overrides.keyId) ?? configuredValue(env.RAZORPAY_KEY_ID);
  const keySecret =
    configuredValue(overrides.keySecret) ?? configuredValue(env.RAZORPAY_KEY_SECRET);
  return keyId && keySecret ? { keyId, keySecret } : null;
};

export interface LudoPurchaseAvailability {
  checkoutConfigured: boolean;
  purchaseEnabled: boolean;
  plans: Record<
    LudoPaidPlanCode,
    {
      checkoutConfigured: boolean;
      purchasable: boolean;
      availabilityReason: LudoPlanAvailabilityReason | null;
    }
  >;
}

export const ludoPurchaseAvailability = (
  env: Pick<Env, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET">,
  credentials?: RazorpayCredentialOverrides,
): LudoPurchaseAvailability => {
  // Membership uses the same Standard Checkout order flow as Add Coins. It
  // therefore needs only the shared key pair; separate Razorpay plan IDs,
  // webhook secrets and admin feature switches must never block checkout.
  const checkoutConfigured = razorpayCredentials(env, credentials) !== null;

  const plans = Object.fromEntries(
    (["PLUS", "PRO"] as LudoPaidPlanCode[]).map((plan) => {
      return [
        plan,
        {
          checkoutConfigured,
          purchasable: checkoutConfigured,
          availabilityReason: checkoutConfigured ? null : "PAYMENT_NOT_CONFIGURED",
        },
      ];
    }),
  ) as LudoPurchaseAvailability["plans"];

  return {
    checkoutConfigured,
    purchaseEnabled: checkoutConfigured,
    plans,
  };
};

export const catalogPlan = (plan: "FREE" | LudoPaidPlanCode): LudoCatalogPlan => {
  const value = LUDO_SUBSCRIPTION_CATALOG.find((item) => item.plan === plan);
  if (!value) throw new Error(`Unknown Ludo subscription plan: ${plan}`);
  return value;
};
