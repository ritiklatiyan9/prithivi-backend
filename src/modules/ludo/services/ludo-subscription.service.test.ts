import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../config/env.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import type { LudoRealtimeHub } from "../sockets/ludo-hub.js";
import type { LudoService } from "./ludo.service.js";
import { LudoSubscriptionService } from "./ludo-subscription.service.js";

const baseEnv = {
  RAZORPAY_API_BASE_URL: "https://api.razorpay.com/v1",
} as Env;

const settings = (purchaseEnabled: boolean): SettingsService =>
  ({
    getBoolean: vi.fn(async () => purchaseEnabled),
    getString: vi.fn(async (key: string) => {
      if (key === "game.ludo.plusPlanName") return "Ludo Plus";
      if (key === "game.ludo.proPlanName") return "Ludo Pro";
      if (key === "game.ludo.plusPlanId") return "plan_plus";
      if (key === "game.ludo.proPlanId") return "plan_pro";
      return "";
    }),
  }) as unknown as SettingsService;

const service = (
  env: Env,
  purchaseEnabled: boolean,
  prisma: Partial<PrismaClient> = {},
): LudoSubscriptionService =>
  new LudoSubscriptionService(
    prisma as PrismaClient,
    settings(purchaseEnabled),
    {} as LudoService,
    {} as LudoRealtimeHub,
    env,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LudoSubscriptionService catalog and checkout gate", () => {
  it("always returns the paid catalog even when checkout is disabled and unconfigured", async () => {
    const plans = await service(baseEnv, false).plans();

    expect(plans).toHaveLength(3);
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plan: "PLUS",
          enabled: true,
          purchasable: false,
          availabilityReason: "PURCHASES_DISABLED",
          pricePaise: 9_900,
        }),
        expect.objectContaining({
          plan: "PRO",
          enabled: true,
          purchasable: false,
          availabilityReason: "PURCHASES_DISABLED",
          pricePaise: 14_900,
        }),
      ]),
    );
  });

  it("fails before touching the database when secure webhook activation is unconfigured", async () => {
    const findFirst = vi.fn();
    const subject = service(
      {
        ...baseEnv,
        RAZORPAY_KEY_ID: "rzp_test_example",
        RAZORPAY_KEY_SECRET: "test-secret",
        RAZORPAY_LUDO_PLUS_PLAN_ID: "plan_plus",
      },
      true,
      { ludoSubscription: { findFirst } } as unknown as PrismaClient,
    );

    await expect(subject.createOrder("user-1", { plan: "PLUS" })).rejects.toMatchObject({
      code: "PAYMENT_NOT_CONFIGURED",
      statusCode: 503,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("refuses a provider plan whose real charge differs from the published price", async () => {
    const findFirst = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "plan_plus",
          period: "monthly",
          interval: 1,
          item: { amount: 1, currency: "INR", active: true },
        }),
      })),
    );
    const subject = service(
      {
        ...baseEnv,
        RAZORPAY_KEY_ID: "rzp_test_example",
        RAZORPAY_KEY_SECRET: "test-secret",
        RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
        RAZORPAY_LUDO_PLUS_PLAN_ID: "plan_plus",
        RAZORPAY_LUDO_PRO_PLAN_ID: "plan_pro",
      },
      true,
      { ludoSubscription: { findFirst } } as unknown as PrismaClient,
    );

    await expect(subject.createOrder("user-1", { plan: "PLUS" })).rejects.toMatchObject({
      code: "PAYMENT_PLAN_MISMATCH",
      statusCode: 503,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns server-owned checkout pricing after validating the provider plan", async () => {
    const now = new Date("2026-08-02T00:00:00.000Z");
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "plan_plus",
          period: "monthly",
          interval: 1,
          item: { amount: 9_900, currency: "INR", active: true },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "sub_123", plan_id: "plan_plus", status: "created" }),
      });
    vi.stubGlobal("fetch", providerFetch);
    const subject = service(
      {
        ...baseEnv,
        RAZORPAY_KEY_ID: "rzp_test_example",
        RAZORPAY_KEY_SECRET: "test-secret",
        RAZORPAY_WEBHOOK_SECRET: "webhook-secret",
        RAZORPAY_LUDO_PLUS_PLAN_ID: "plan_plus",
        RAZORPAY_LUDO_PRO_PLAN_ID: "plan_pro",
      },
      true,
      {
        ludoSubscription: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async () => ({
            id: "record-1",
            plan: "PLUS",
            status: "PENDING",
            razorpaySubscriptionId: "sub_123",
            currentPeriodStart: null,
            currentPeriodEnd: null,
            cancelledAt: null,
            createdAt: now,
            updatedAt: now,
          })),
        },
      } as unknown as PrismaClient,
    );

    await expect(subject.createOrder("user-1", { plan: "PLUS" })).resolves.toMatchObject({
      keyId: "rzp_test_example",
      subscriptionId: "sub_123",
      amountPaise: 9_900,
      currency: "INR",
      description: "Ludo Plus membership",
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });
});
