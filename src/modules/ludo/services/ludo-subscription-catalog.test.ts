import { describe, expect, it } from "vitest";
import type { Env } from "../../../config/env.js";
import {
  LUDO_SUBSCRIPTION_CATALOG,
  configuredValue,
  ludoPurchaseAvailability,
} from "./ludo-subscription-catalog.js";

type PaymentEnv = Pick<
  Env,
  | "RAZORPAY_KEY_ID"
  | "RAZORPAY_KEY_SECRET"
  | "RAZORPAY_WEBHOOK_SECRET"
  | "RAZORPAY_LUDO_PLUS_PLAN_ID"
  | "RAZORPAY_LUDO_PRO_PLAN_ID"
>;

const configuredEnv = (overrides: Partial<PaymentEnv> = {}): PaymentEnv => ({
  RAZORPAY_KEY_ID: "rzp_test_example",
  RAZORPAY_KEY_SECRET: "test-secret",
  RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
  RAZORPAY_LUDO_PLUS_PLAN_ID: "plan_plus",
  RAZORPAY_LUDO_PRO_PLAN_ID: "plan_pro",
  ...overrides,
});

describe("Ludo subscription catalog", () => {
  it("publishes the fixed monthly prices and communication benefits", () => {
    expect(LUDO_SUBSCRIPTION_CATALOG).toMatchObject([
      { plan: "FREE", pricePaise: 0 },
      {
        plan: "PLUS",
        pricePaise: 9_900,
        period: "MONTHLY",
        entitlements: { quickChat: true, textChat: true, voiceChat: false },
      },
      {
        plan: "PRO",
        pricePaise: 14_900,
        period: "MONTHLY",
        entitlements: { quickChat: true, textChat: true, voiceChat: true },
      },
    ]);
  });

  it("separates catalog visibility from checkout availability", () => {
    const availability = ludoPurchaseAvailability(configuredEnv(), false);

    expect(availability).toMatchObject({
      settingEnabled: false,
      checkoutConfigured: true,
      purchaseEnabled: false,
      plans: {
        PLUS: {
          checkoutConfigured: true,
          purchasable: false,
          availabilityReason: "PURCHASES_DISABLED",
        },
        PRO: {
          checkoutConfigured: true,
          purchasable: false,
          availabilityReason: "PURCHASES_DISABLED",
        },
      },
    });
  });

  it("allows test checkout to provision missing plans without a webhook secret", () => {
    const noWebhook = ludoPurchaseAvailability(
      configuredEnv({ RAZORPAY_WEBHOOK_SECRET: undefined }),
      true,
      undefined,
    );
    expect(noWebhook.purchaseEnabled).toBe(true);
    expect(noWebhook.plans.PLUS.availabilityReason).toBeNull();

    const noProPlan = ludoPurchaseAvailability(
      configuredEnv({ RAZORPAY_LUDO_PRO_PLAN_ID: undefined }),
      true,
      undefined,
    );
    expect(noProPlan.purchaseEnabled).toBe(true);
    expect(noProPlan.plans.PLUS.purchasable).toBe(true);
    expect(noProPlan.plans.PRO).toMatchObject({
      purchasable: true,
      availabilityReason: null,
      providerPlanId: null,
    });

    const ready = ludoPurchaseAvailability(configuredEnv(), true);
    expect(ready.purchaseEnabled).toBe(true);
    expect(ready.plans.PLUS.purchasable).toBe(true);
    expect(ready.plans.PRO.purchasable).toBe(true);
  });

  it("rejects blank and deployment-template placeholders", () => {
    expect(configuredValue("   ")).toBeNull();
    expect(configuredValue("CHANGE_ME")).toBeNull();
    expect(configuredValue("plan_CHANGE_ME")).toBeNull();
    expect(configuredValue("plan_live123")).toBe("plan_live123");
  });
});
