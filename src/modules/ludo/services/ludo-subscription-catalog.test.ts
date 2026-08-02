import { describe, expect, it } from "vitest";
import type { Env } from "../../../config/env.js";
import {
  LUDO_SUBSCRIPTION_CATALOG,
  configuredValue,
  ludoPurchaseAvailability,
} from "./ludo-subscription-catalog.js";

type PaymentEnv = Pick<Env, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET">;

const configuredEnv = (overrides: Partial<PaymentEnv> = {}): PaymentEnv => ({
  RAZORPAY_KEY_ID: "rzp_test_example",
  RAZORPAY_KEY_SECRET: "test-secret",
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

  it("keeps the catalog visible but disables checkout without the shared key pair", () => {
    const availability = ludoPurchaseAvailability(
      configuredEnv({ RAZORPAY_KEY_ID: undefined, RAZORPAY_KEY_SECRET: undefined }),
    );

    expect(availability).toMatchObject({
      checkoutConfigured: false,
      purchaseEnabled: false,
      plans: {
        PLUS: {
          checkoutConfigured: false,
          purchasable: false,
          availabilityReason: "PAYMENT_NOT_CONFIGURED",
        },
        PRO: {
          checkoutConfigured: false,
          purchasable: false,
          availabilityReason: "PAYMENT_NOT_CONFIGURED",
        },
      },
    });
  });

  it("enables both plans from the same credentials used by Add Coins", () => {
    const ready = ludoPurchaseAvailability(configuredEnv());
    expect(ready.purchaseEnabled).toBe(true);
    expect(ready.plans.PLUS.purchasable).toBe(true);
    expect(ready.plans.PRO.purchasable).toBe(true);
    expect(ready.plans.PLUS.availabilityReason).toBeNull();
  });

  it("rejects blank and deployment-template placeholders", () => {
    expect(configuredValue("   ")).toBeNull();
    expect(configuredValue("CHANGE_ME")).toBeNull();
    expect(configuredValue("plan_CHANGE_ME")).toBeNull();
    expect(configuredValue("plan_live123")).toBe("plan_live123");
  });
});
