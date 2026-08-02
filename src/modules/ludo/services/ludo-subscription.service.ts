import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  Prisma,
  type LudoPlan,
  type LudoSubscriptionStatus,
  type PrismaClient,
} from "@prisma/client";
import { AppError, BadRequestError, NotFoundError } from "../../../common/errors.js";
import type { Env } from "../../../config/env.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import type {
  CreateSubscriptionOrderInput,
  VerifySubscriptionInput,
} from "../schemas/ludo.schema.js";
import type { LudoRealtimeHub } from "../sockets/ludo-hub.js";
import type { LudoService } from "./ludo.service.js";
import {
  LUDO_SUBSCRIPTION_CATALOG,
  catalogPlan,
  configuredValue,
  ludoPurchaseAvailability,
  razorpayCredentials,
  type LudoPurchaseAvailability,
} from "./ludo-subscription-catalog.js";

interface RazorpaySubscription {
  id: string;
  plan_id: string;
  customer_id?: string | null;
  status: string;
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
}

interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  captured: boolean;
}

interface RazorpayWebhook {
  event?: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: RazorpaySubscription };
    payment?: {
      entity?: {
        id?: string;
        subscription_id?: string;
        amount?: number;
        currency?: string;
      };
    };
  };
}

const fromUnix = (value: number | null | undefined): Date | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;

const mapProviderStatus = (status: string): LudoSubscriptionStatus => {
  switch (status.toLowerCase()) {
    case "active":
      return "ACTIVE";
    case "authenticated":
      return "AUTHENTICATED";
    case "paused":
      return "PAUSED";
    case "cancelled":
      return "CANCELLED";
    case "completed":
      return "COMPLETED";
    case "expired":
      return "EXPIRED";
    case "halted":
      return "PAYMENT_FAILED";
    case "pending":
    case "created":
    default:
      return "PENDING";
  }
};

export class LudoSubscriptionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly ludo: LudoService,
    private readonly hub: LudoRealtimeHub,
    private readonly env: Env,
  ) {}

  async plans(): Promise<Record<string, unknown>[]> {
    const credentials = await this.credentials();
    const availability = ludoPurchaseAvailability(this.env, credentials ?? undefined);

    // `enabled` means that the catalog item is published, not that payment
    // infrastructure happens to be ready. Older app builds filter the catalog
    // on this field, so coupling it to credentials made both paid plans vanish.
    return LUDO_SUBSCRIPTION_CATALOG.map((plan) => {
      const payment = plan.plan === "FREE" ? null : availability.plans[plan.plan];
      return {
        plan: plan.plan,
        code: plan.code,
        name: plan.defaultName,
        enabled: true,
        purchasable: payment?.purchasable ?? false,
        checkoutConfigured: payment?.checkoutConfigured ?? false,
        availabilityReason: payment?.availabilityReason ?? null,
        pricePaise: plan.pricePaise,
        currency: "INR",
        period: plan.period,
        features: [...plan.features],
        entitlements: plan.entitlements,
      };
    });
  }

  async purchaseAvailability(): Promise<LudoPurchaseAvailability> {
    const credentials = await this.credentials();
    return ludoPurchaseAvailability(this.env, credentials ?? undefined);
  }

  async current(userId: string): Promise<Record<string, unknown>> {
    const [entitlement, subscription] = await Promise.all([
      this.ludo.effectiveEntitlement(userId),
      this.prisma.ludoSubscription.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    const cancelAtPeriodEnd =
      subscription?.razorpaySubscriptionId.startsWith("order_") === true ||
      (subscription?.cancelledAt !== null && subscription?.cancelledAt !== undefined);
    const enrichedEntitlement = {
      ...entitlement,
      renewsAt: entitlement.plan !== "FREE" && !cancelAtPeriodEnd ? entitlement.expiresAt : null,
      cancelAtPeriodEnd,
    };
    return {
      ...enrichedEntitlement,
      entitlement: enrichedEntitlement,
      subscription: subscription ? this.dto(subscription) : null,
    };
  }

  async history(userId: string): Promise<Record<string, unknown>[]> {
    const events = await this.prisma.ludoPaymentEvent.findMany({
      where: { subscription: { userId } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { subscription: { select: { plan: true, razorpaySubscriptionId: true } } },
    });
    return events.map((event) => {
      const summary = (event.summary ?? {}) as Record<string, unknown>;
      return {
        id: event.id,
        eventId: event.razorpayEventId,
        subscriptionId: event.subscription?.razorpaySubscriptionId ?? null,
        plan: event.subscription?.plan ?? "FREE",
        type: event.type,
        status: event.status,
        amountPaise: typeof summary.amountPaise === "number" ? summary.amountPaise : null,
        currency: typeof summary.currency === "string" ? summary.currency : null,
        date: event.processedAt?.toISOString() ?? event.createdAt.toISOString(),
      };
    });
  }

  async createOrder(
    userId: string,
    input: CreateSubscriptionOrderInput,
  ): Promise<Record<string, unknown>> {
    const availability = await this.purchaseAvailability();
    const planAvailability = availability.plans[input.plan];
    const credentials = await this.credentials();
    if (!planAvailability.purchasable || !credentials) {
      throw new AppError("Razorpay is not configured", 503, "PAYMENT_NOT_CONFIGURED");
    }
    const plan = catalogPlan(input.plan);
    const active = await this.prisma.ludoSubscription.findFirst({
      where: {
        userId,
        status: { in: ["AUTHENTICATED", "ACTIVE", "PAUSED"] },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (active) {
      throw new BadRequestError("An active membership already exists");
    }

    const pending = await this.prisma.ludoSubscription.findFirst({
      where: {
        userId,
        plan: input.plan,
        status: "PENDING",
        razorpaySubscriptionId: { startsWith: "order_" },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
    });
    if (pending) {
      return {
        ...this.dto(pending),
        subscriptionId: null,
        orderId: pending.razorpaySubscriptionId,
        keyId: credentials.keyId,
        amountPaise: plan.pricePaise,
        currency: "INR",
        name: "Money Marathon",
        description: `${plan.defaultName} membership`,
      };
    }

    const order = await this.razorpay<RazorpayOrder>("/orders", {
      method: "POST",
      body: {
        amount: plan.pricePaise,
        currency: "INR",
        receipt: `membership_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        notes: { userId, purpose: "ludo_membership", plan: input.plan },
      },
    });
    if (
      !order.id.startsWith("order_") ||
      order.amount !== plan.pricePaise ||
      order.currency !== "INR"
    ) {
      throw new AppError(
        "Razorpay returned an invalid membership order",
        502,
        "PAYMENT_PROVIDER_ERROR",
      );
    }
    const row = await this.prisma.ludoSubscription.create({
      data: {
        userId,
        plan: input.plan,
        status: "PENDING",
        razorpaySubscriptionId: order.id,
        razorpayPlanId: `standard_order_${input.plan}`,
      },
    });
    return {
      ...this.dto(row),
      subscriptionId: null,
      orderId: order.id,
      keyId: credentials.keyId,
      amountPaise: plan.pricePaise,
      currency: "INR",
      name: "Money Marathon",
      description: `${plan.defaultName} membership`,
    };
  }

  async verify(userId: string, input: VerifySubscriptionInput): Promise<Record<string, unknown>> {
    if (input.subscriptionId.startsWith("order_")) {
      return this.verifyMembershipOrder(userId, input);
    }
    const row = await this.prisma.ludoSubscription.findUnique({
      where: { razorpaySubscriptionId: input.subscriptionId },
    });
    if (!row || row.userId !== userId) throw new NotFoundError("Ludo subscription not found");
    await this.verifyCheckoutSignature(input.paymentId, input.subscriptionId, input.signature);
    const provider = await this.razorpay<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      { method: "GET" },
    );
    if (provider.id !== row.razorpaySubscriptionId || provider.plan_id !== row.razorpayPlanId) {
      throw new BadRequestError("Subscription verification did not match this order");
    }
    // Checkout verification proves possession only. Entitlements are changed
    // exclusively by signed webhook lifecycle events.
    const updated = await this.prisma.ludoSubscription.update({
      where: { id: row.id },
      data: {
        status: row.status === "PENDING" ? "AUTHENTICATED" : row.status,
        latestPaymentId: input.paymentId,
        razorpayCustomerId: provider.customer_id ?? row.razorpayCustomerId,
      },
    });
    return { authenticated: true, status: updated.status, subscription: this.dto(updated) };
  }

  async restore(userId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.ludoSubscription.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return this.current(userId);
    if (row.razorpaySubscriptionId.startsWith("order_")) return this.current(userId);
    const provider = await this.razorpay<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(row.razorpaySubscriptionId)}`,
      { method: "GET" },
    );
    await this.applyLifecycle(row.id, provider, row.latestPaymentId);
    return this.current(userId);
  }

  async cancel(userId: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.ludoSubscription.findFirst({
      where: { userId, status: { in: ["AUTHENTICATED", "ACTIVE", "PAUSED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw new NotFoundError("No cancellable Ludo subscription was found");
    if (row.razorpaySubscriptionId.startsWith("order_")) {
      await this.prisma.ludoSubscription.update({
        where: { id: row.id },
        data: { cancelledAt: row.cancelledAt ?? new Date() },
      });
      return this.current(userId);
    }
    const provider = await this.razorpay<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(row.razorpaySubscriptionId)}/cancel`,
      { method: "POST", body: { cancel_at_cycle_end: 1 } },
    );
    await this.applyLifecycle(row.id, provider, row.latestPaymentId);
    await this.prisma.ludoSubscription.update({
      where: { id: row.id },
      data: {
        cancelledAt: new Date(),
        currentPeriodEnd: fromUnix(provider.current_end) ?? row.currentPeriodEnd,
      },
    });
    return this.current(userId);
  }

  async webhook(
    rawBody: Buffer,
    signature: string | undefined,
    eventId: string | undefined,
  ): Promise<Record<string, unknown>> {
    await this.verifyWebhookSignature(rawBody, signature);
    let body: RazorpayWebhook;
    try {
      body = JSON.parse(rawBody.toString("utf8")) as RazorpayWebhook;
    } catch {
      throw new BadRequestError("Malformed Razorpay webhook JSON");
    }
    const providerEntity = body.payload?.subscription?.entity;
    const providerSubscriptionId =
      providerEntity?.id ?? body.payload?.payment?.entity?.subscription_id;
    const stableEventId = eventId?.trim();
    if (!stableEventId || stableEventId.length > 200) {
      throw new BadRequestError("Missing Razorpay webhook event id");
    }

    let paymentEvent;
    try {
      paymentEvent = await this.prisma.ludoPaymentEvent.create({
        data: {
          razorpayEventId: stableEventId,
          type: body.event ?? "unknown",
          razorpayPaymentId: body.payload?.payment?.entity?.id,
          summary: {
            providerSubscriptionId: providerSubscriptionId ?? null,
            providerCreatedAt: body.created_at ?? null,
            amountPaise: body.payload?.payment?.entity?.amount ?? null,
            currency: body.payload?.payment?.entity?.currency ?? null,
          },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.ludoPaymentEvent.findUnique({
          where: { razorpayEventId: stableEventId },
        });
        if (existing?.status === "FAILED") {
          const claimed = await this.prisma.ludoPaymentEvent.updateMany({
            where: { id: existing.id, status: "FAILED" },
            data: { status: "PROCESSING", error: null, processedAt: null },
          });
          if (claimed.count === 1) paymentEvent = { ...existing, status: "PROCESSING" as const };
          else return { accepted: true, duplicate: true };
        } else {
          return { accepted: true, duplicate: true };
        }
      } else {
        throw error;
      }
    }

    if (!providerSubscriptionId) {
      await this.finishPaymentEvent(paymentEvent.id, "IGNORED", null, "No subscription id");
      return { accepted: true, ignored: true };
    }
    const subscription = await this.prisma.ludoSubscription.findUnique({
      where: { razorpaySubscriptionId: providerSubscriptionId },
    });
    if (!subscription) {
      await this.finishPaymentEvent(paymentEvent.id, "IGNORED", null, "Unknown subscription");
      return { accepted: true, ignored: true };
    }

    try {
      const provider = await this.razorpay<RazorpaySubscription>(
        `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
        { method: "GET" },
      );
      if (!provider || provider.plan_id !== subscription.razorpayPlanId) {
        throw new BadRequestError("Webhook subscription plan mismatch");
      }
      await this.applyLifecycle(
        subscription.id,
        provider,
        body.payload?.payment?.entity?.id ?? null,
      );
      await this.finishPaymentEvent(paymentEvent.id, "PROCESSED", subscription.id, null);
      const entitlement = await this.ludo.effectiveEntitlement(subscription.userId);
      this.hub.send(subscription.userId, this.hub.event("entitlement.updated", { entitlement }));
      return { accepted: true, duplicate: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finishPaymentEvent(paymentEvent.id, "FAILED", subscription.id, message);
      throw error;
    }
  }

  private async applyLifecycle(
    subscriptionId: string,
    provider: RazorpaySubscription,
    paymentId: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.ludoSubscription.update({
        where: { id: subscriptionId },
        data: {
          status: mapProviderStatus(provider.status),
          razorpayCustomerId: provider.customer_id ?? undefined,
          latestPaymentId: paymentId ?? undefined,
          currentPeriodStart: fromUnix(provider.current_start),
          currentPeriodEnd: fromUnix(provider.current_end),
          ...(provider.status.toLowerCase() === "cancelled" ? { cancelledAt: new Date() } : {}),
        },
      });
      const periodStart = fromUnix(provider.current_start) ?? new Date();
      const periodEnd = fromUnix(provider.current_end);
      const providerActive = provider.status.toLowerCase() === "active";
      const cancelledButPaid =
        provider.status.toLowerCase() === "cancelled" &&
        periodEnd !== null &&
        periodEnd.getTime() > Date.now();
      const entitled = (providerActive || cancelledButPaid) && periodEnd !== null;
      await tx.ludoEntitlement.upsert({
        where: { userId: row.userId },
        create: {
          userId: row.userId,
          plan: entitled ? row.plan : "FREE",
          status: entitled ? "ACTIVE" : "EXPIRED",
          sourceSubscriptionId: entitled ? row.id : null,
          startsAt: entitled ? periodStart : null,
          expiresAt: entitled ? periodEnd : null,
        },
        update: {
          plan: entitled ? row.plan : "FREE",
          status: entitled ? "ACTIVE" : "EXPIRED",
          sourceSubscriptionId: entitled ? row.id : null,
          startsAt: entitled ? periodStart : null,
          expiresAt: entitled ? periodEnd : null,
          version: { increment: 1 },
        },
      });
    });
  }

  private async finishPaymentEvent(
    id: string,
    status: "PROCESSED" | "IGNORED" | "FAILED",
    subscriptionRecordId: string | null,
    error: string | null,
  ): Promise<void> {
    await this.prisma.ludoPaymentEvent.update({
      where: { id },
      data: {
        status,
        subscriptionRecordId,
        error: error?.slice(0, 500) ?? null,
        processedAt: new Date(),
      },
    });
  }

  private dto(row: {
    id: string;
    plan: LudoPlan;
    status: LudoSubscriptionStatus;
    razorpaySubscriptionId: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Record<string, unknown> {
    return {
      id: row.id,
      plan: row.plan,
      status: row.status,
      subscriptionId: row.razorpaySubscriptionId,
      currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async credentials(): Promise<{ keyId: string; keySecret: string } | null> {
    const [settingKeyId, settingKeySecret] = await Promise.all([
      this.settings.getString("payment.razorpay.keyId"),
      this.settings.getString("payment.razorpay.keySecret"),
    ]);
    return razorpayCredentials(this.env, {
      keyId: settingKeyId,
      keySecret: settingKeySecret,
    });
  }

  private async verifyMembershipOrder(
    userId: string,
    input: VerifySubscriptionInput,
  ): Promise<Record<string, unknown>> {
    const row = await this.prisma.ludoSubscription.findUnique({
      where: { razorpaySubscriptionId: input.subscriptionId },
    });
    if (!row || row.userId !== userId || !row.razorpaySubscriptionId.startsWith("order_")) {
      throw new NotFoundError("Membership order not found");
    }
    if (row.status === "ACTIVE" && row.latestPaymentId === input.paymentId) {
      return { authenticated: true, status: row.status, subscription: this.dto(row) };
    }

    const credentials = await this.credentials();
    if (!credentials) {
      throw new AppError("Razorpay is not configured", 503, "PAYMENT_NOT_CONFIGURED");
    }
    const expected = createHmac("sha256", credentials.keySecret)
      .update(`${row.razorpaySubscriptionId}|${input.paymentId}`)
      .digest("hex");
    if (!this.safeEqual(expected, input.signature)) {
      throw new BadRequestError("Invalid payment signature");
    }

    let payment = await this.razorpay<RazorpayPayment>(
      `/payments/${encodeURIComponent(input.paymentId)}`,
      { method: "GET" },
    );
    const expectedAmount = catalogPlan(row.plan).pricePaise;
    const assertPayment = (candidate: RazorpayPayment): void => {
      if (
        candidate.id !== input.paymentId ||
        candidate.order_id !== row.razorpaySubscriptionId ||
        candidate.amount !== expectedAmount ||
        candidate.currency !== "INR"
      ) {
        throw new BadRequestError("Payment does not match this membership order");
      }
    };
    assertPayment(payment);
    if (payment.status === "authorized") {
      payment = await this.razorpay<RazorpayPayment>(
        `/payments/${encodeURIComponent(input.paymentId)}/capture`,
        { method: "POST", body: { amount: expectedAmount, currency: "INR" } },
      );
      assertPayment(payment);
    }
    if (payment.status !== "captured" || payment.captured !== true) {
      throw new BadRequestError("Payment is not captured yet. Please try again shortly.");
    }

    const startsAt = new Date();
    const expiresAt = new Date(startsAt);
    expiresAt.setMonth(expiresAt.getMonth() + 1);
    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.ludoSubscription.updateMany({
        where: { id: row.id, status: { in: ["PENDING", "AUTHENTICATED"] } },
        data: {
          status: "ACTIVE",
          latestPaymentId: input.paymentId,
          currentPeriodStart: startsAt,
          currentPeriodEnd: expiresAt,
        },
      });
      const subscription = await tx.ludoSubscription.findUniqueOrThrow({
        where: { id: row.id },
      });
      if (claimed.count === 0) {
        if (subscription.status === "ACTIVE" && subscription.latestPaymentId === input.paymentId) {
          return { subscription, newlyActivated: false };
        }
        throw new BadRequestError("This membership order has already been completed");
      }
      await tx.ludoEntitlement.upsert({
        where: { userId },
        create: {
          userId,
          plan: row.plan,
          status: "ACTIVE",
          sourceSubscriptionId: row.id,
          startsAt,
          expiresAt,
        },
        update: {
          plan: row.plan,
          status: "ACTIVE",
          sourceSubscriptionId: row.id,
          startsAt,
          expiresAt,
          version: { increment: 1 },
        },
      });
      await tx.ludoPaymentEvent.upsert({
        where: { razorpayEventId: `membership-order:${input.paymentId}` },
        create: {
          razorpayEventId: `membership-order:${input.paymentId}`,
          type: "payment.captured",
          status: "PROCESSED",
          subscriptionRecordId: row.id,
          razorpayPaymentId: input.paymentId,
          summary: {
            providerOrderId: row.razorpaySubscriptionId,
            amountPaise: expectedAmount,
            currency: "INR",
            checkoutType: "standard_order",
          },
          processedAt: startsAt,
        },
        update: {},
      });
      return { subscription, newlyActivated: true };
    });
    if (result.newlyActivated) {
      const entitlement = await this.ludo.effectiveEntitlement(userId);
      this.hub.send(userId, this.hub.event("entitlement.updated", { entitlement }));
    }
    return {
      authenticated: true,
      status: result.subscription.status,
      subscription: this.dto(result.subscription),
    };
  }

  private async verifyCheckoutSignature(
    paymentId: string,
    subscriptionId: string,
    signature: string,
  ): Promise<void> {
    const credentials = await this.credentials();
    if (!credentials)
      throw new AppError("Razorpay is not configured", 503, "PAYMENT_NOT_CONFIGURED");
    const expected = createHmac("sha256", credentials.keySecret)
      .update(`${paymentId}|${subscriptionId}`)
      .digest("hex");
    if (!this.safeEqual(expected, signature))
      throw new BadRequestError("Invalid payment signature");
  }

  private async verifyWebhookSignature(
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<void> {
    if (!signature) throw new BadRequestError("Missing Razorpay webhook signature");
    const settingWebhookSecret = await this.settings.getString("payment.razorpay.webhookSecret");
    const secrets = [
      settingWebhookSecret,
      this.env.RAZORPAY_WEBHOOK_SECRET,
      this.env.RAZORPAY_WEBHOOK_SECRET_PREVIOUS,
    ]
      .map(configuredValue)
      .filter((value): value is string => value !== null)
      .filter((value, index, values) => values.indexOf(value) === index);
    if (secrets.length === 0) {
      throw new AppError("Razorpay webhook is not configured", 503, "PAYMENT_NOT_CONFIGURED");
    }
    const valid = secrets.some((secret) => {
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      return this.safeEqual(expected, signature);
    });
    if (!valid) throw new BadRequestError("Invalid Razorpay webhook signature");
  }

  private safeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async razorpay<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: Record<string, unknown> },
  ): Promise<T> {
    const credentials = await this.credentials();
    if (!credentials)
      throw new AppError("Razorpay is not configured", 503, "PAYMENT_NOT_CONFIGURED");
    const response = await fetch(`${this.env.RAZORPAY_API_BASE_URL}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => {
      throw new AppError(
        error instanceof Error ? error.message : "Razorpay request failed",
        502,
        "PAYMENT_PROVIDER_ERROR",
      );
    });
    const payload = (await response.json().catch(() => null)) as {
      error?: { description?: string; reason?: string };
    } | null;
    if (!response.ok) {
      const message =
        response.status === 401
          ? "Razorpay rejected the saved Key ID or Key Secret"
          : payload?.error?.description?.trim() ||
            payload?.error?.reason?.trim() ||
            "Razorpay rejected the request";
      throw new AppError(message, 502, "PAYMENT_PROVIDER_ERROR");
    }
    return payload as T;
  }
}
