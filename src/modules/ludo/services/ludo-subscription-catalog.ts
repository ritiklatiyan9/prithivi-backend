import type { Env } from "../../../config/env.js";

export type LudoPaidPlanCode = "PLUS" | "PRO";
export type LudoPlanAvailabilityReason =
  "PURCHASES_DISABLED" | "PAYMENT_NOT_CONFIGURED" | "PLAN_NOT_CONFIGURED";

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
  webhookSecret?: string;
}

export const razorpayCredentials = (
  env: Pick<Env, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET">,
  overrides: RazorpayCredentialOverrides = {},
): { keyId: string; keySecret: string } | null => {
  const keyId = configuredValue(overrides.keyId) ?? configuredValue(env.RAZORPAY_KEY_ID);
  const keySecret = configuredValue(overrides.keySecret) ?? configuredValue(env.RAZORPAY_KEY_SECRET);
  return keyId && keySecret ? { keyId, keySecret } : null;
};

export interface LudoPurchaseAvailability {
  settingEnabled: boolean;
  checkoutConfigured: boolean;
  purchaseEnabled: boolean;
  plans: Record<
    LudoPaidPlanCode,
    {
      checkoutConfigured: boolean;
      purchasable: boolean;
      availabilityReason: LudoPlanAvailabilityReason | null;
      providerPlanId: string | null;
    }
  >;
}

export const ludoPurchaseAvailability = (
  env: Pick<
    Env,
    | "RAZORPAY_KEY_ID"
    | "RAZORPAY_KEY_SECRET"
    | "RAZORPAY_WEBHOOK_SECRET"
    | "RAZORPAY_LUDO_PLUS_PLAN_ID"
    | "RAZORPAY_LUDO_PRO_PLAN_ID"
  >,
  settingEnabled: boolean,
  planIds?: {
    plusPlanId?: string;
    proPlanId?: string;
  },
  credentials?: RazorpayCredentialOverrides,
): LudoPurchaseAvailability => {
  const providerCredentials = razorpayCredentials(env, credentials);
  const webhookConfigured =
    (configuredValue(credentials?.webhookSecret) ??
      configuredValue(env.RAZORPAY_WEBHOOK_SECRET)) !== null;
  const canProvisionTestPlans = providerCredentials?.keyId.startsWith("rzp_test_") === true;
  const providerReady =
    providerCredentials !== null &&
    (providerCredentials.keyId.startsWith("rzp_test_") || webhookConfigured);
  const providerPlanIds: Record<LudoPaidPlanCode, string | null> = {
    PLUS:
      configuredValue(planIds?.plusPlanId) ??
      configuredValue(env.RAZORPAY_LUDO_PLUS_PLAN_ID),
    PRO: configuredValue(planIds?.proPlanId) ?? configuredValue(env.RAZORPAY_LUDO_PRO_PLAN_ID),
  };

  const plans = Object.fromEntries(
    (Object.keys(providerPlanIds) as LudoPaidPlanCode[]).map((plan) => {
      const checkoutConfigured =
        providerReady && (providerPlanIds[plan] !== null || canProvisionTestPlans);
      const purchasable = settingEnabled && checkoutConfigured;
      const availabilityReason: LudoPlanAvailabilityReason | null = !settingEnabled
        ? "PURCHASES_DISABLED"
        : !providerReady
          ? "PAYMENT_NOT_CONFIGURED"
          : providerPlanIds[plan] === null && !canProvisionTestPlans
            ? "PLAN_NOT_CONFIGURED"
            : null;
      return [
        plan,
        {
          checkoutConfigured,
          purchasable,
          availabilityReason,
          providerPlanId: providerPlanIds[plan],
        },
      ];
    }),
  ) as LudoPurchaseAvailability["plans"];

  // The legacy runtime boolean is consumed globally by older clients, so it
  // is true only when both advertised paid plans can actually open checkout.
  const checkoutConfigured = plans.PLUS.checkoutConfigured && plans.PRO.checkoutConfigured;
  return {
    settingEnabled,
    checkoutConfigured,
    purchaseEnabled: settingEnabled && checkoutConfigured,
    plans,
  };
};

export const catalogPlan = (plan: "FREE" | LudoPaidPlanCode): LudoCatalogPlan => {
  const value = LUDO_SUBSCRIPTION_CATALOG.find((item) => item.plan === plan);
  if (!value) throw new Error(`Unknown Ludo subscription plan: ${plan}`);
  return value;
};
