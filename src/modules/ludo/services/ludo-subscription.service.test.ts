import { createHmac } from "node:crypto";
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

const settings = (values: Record<string, string> = {}): SettingsService =>
  ({
    getBoolean: vi.fn(async () => false),
    getString: vi.fn(async (key: string) => values[key] ?? ""),
  }) as unknown as SettingsService;

const service = (
  env: Env,
  prisma: Partial<PrismaClient> = {},
  settingValues: Record<string, string> = {},
): LudoSubscriptionService =>
  new LudoSubscriptionService(
    prisma as PrismaClient,
    settings(settingValues),
    {} as LudoService,
    {} as LudoRealtimeHub,
    env,
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LudoSubscriptionService catalog and checkout gate", () => {
  it("always returns the paid catalog even when checkout is disabled and unconfigured", async () => {
    const plans = await service(baseEnv).plans();

    expect(plans).toHaveLength(3);
    expect(plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plan: "PLUS",
          enabled: true,
          purchasable: false,
          availabilityReason: "PAYMENT_NOT_CONFIGURED",
          pricePaise: 9_900,
        }),
        expect.objectContaining({
          plan: "PRO",
          enabled: true,
          purchasable: false,
          availabilityReason: "PAYMENT_NOT_CONFIGURED",
          pricePaise: 14_900,
        }),
      ]),
    );
  });

  it("fails before touching the database when the shared Razorpay keys are unconfigured", async () => {
    const findFirst = vi.fn();
    const subject = service(baseEnv, {
      ludoSubscription: { findFirst },
    } as unknown as PrismaClient);

    await expect(subject.createOrder("user-1", { plan: "PLUS" })).rejects.toMatchObject({
      code: "PAYMENT_NOT_CONFIGURED",
      statusCode: 503,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("refuses a Razorpay order whose charge differs from the published price", async () => {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "order_wrong",
          amount: 1,
          currency: "INR",
          status: "created",
        }),
      })),
    );
    const subject = service(
      baseEnv,
      { ludoSubscription: { findFirst, create } } as unknown as PrismaClient,
      {
        "payment.razorpay.keyId": "rzp_test_example",
        "payment.razorpay.keySecret": "test-secret",
      },
    );

    await expect(subject.createOrder("user-1", { plan: "PLUS" })).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_ERROR",
      statusCode: 502,
    });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a Standard Checkout order using the saved Add Coins credentials", async () => {
    const now = new Date("2026-08-02T00:00:00.000Z");
    const providerFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "order_123",
        amount: 9_900,
        currency: "INR",
        status: "created",
      }),
    }));
    vi.stubGlobal("fetch", providerFetch);
    const subject = service(
      baseEnv,
      {
        ludoSubscription: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async () => ({
            id: "record-1",
            plan: "PLUS",
            status: "PENDING",
            razorpaySubscriptionId: "order_123",
            currentPeriodStart: null,
            currentPeriodEnd: null,
            cancelledAt: null,
            createdAt: now,
            updatedAt: now,
          })),
        },
      } as unknown as PrismaClient,
      {
        "payment.razorpay.keyId": "rzp_live_shared",
        "payment.razorpay.keySecret": "live-shared-secret",
      },
    );

    await expect(subject.createOrder("user-1", { plan: "PLUS" })).resolves.toMatchObject({
      keyId: "rzp_live_shared",
      subscriptionId: null,
      orderId: "order_123",
      amountPaise: 9_900,
      currency: "INR",
      description: "Ludo Plus membership",
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.razorpay.com/v1/orders",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("verifies and captures an order before activating one month of membership", async () => {
    const now = new Date("2026-08-02T00:00:00.000Z");
    const pending = {
      id: "record-1",
      userId: "user-1",
      plan: "PLUS" as const,
      status: "PENDING" as const,
      razorpaySubscriptionId: "order_123",
      razorpayPlanId: "standard_order_PLUS",
      razorpayCustomerId: null,
      latestPaymentId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const active = {
      ...pending,
      status: "ACTIVE" as const,
      latestPaymentId: "pay_123",
      currentPeriodStart: now,
      currentPeriodEnd: new Date("2026-09-02T00:00:00.000Z"),
    };
    const entitlementUpsert = vi.fn();
    const paymentEventUpsert = vi.fn();
    const transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        ludoSubscription: {
          updateMany: vi.fn(async () => ({ count: 1 })),
          findUniqueOrThrow: vi.fn(async () => active),
        },
        ludoEntitlement: { upsert: entitlementUpsert },
        ludoPaymentEvent: { upsert: paymentEventUpsert },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          id: "pay_123",
          order_id: "order_123",
          amount: 9_900,
          currency: "INR",
          status: "captured",
          captured: true,
        }),
      })),
    );
    const keySecret = "shared-secret";
    const signature = createHmac("sha256", keySecret).update("order_123|pay_123").digest("hex");
    const effectiveEntitlement = vi.fn(async () => ({ plan: "PLUS", status: "ACTIVE" }));
    const send = vi.fn();
    const subject = new LudoSubscriptionService(
      {
        ludoSubscription: { findUnique: vi.fn(async () => pending) },
        $transaction: transaction,
      } as unknown as PrismaClient,
      settings({
        "payment.razorpay.keyId": "rzp_live_shared",
        "payment.razorpay.keySecret": keySecret,
      }),
      { effectiveEntitlement } as unknown as LudoService,
      { event: vi.fn((_type, payload) => payload), send } as unknown as LudoRealtimeHub,
      baseEnv,
    );

    await expect(
      subject.verify("user-1", {
        subscriptionId: "order_123",
        paymentId: "pay_123",
        signature,
      }),
    ).resolves.toMatchObject({ status: "ACTIVE" });
    expect(entitlementUpsert).toHaveBeenCalledOnce();
    expect(paymentEventUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          razorpayPaymentId: "pay_123",
          subscriptionRecordId: "record-1",
        }),
      }),
    );
    expect(send).toHaveBeenCalledOnce();
  });
});
