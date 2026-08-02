import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { CoinPurchase, PrismaClient } from "@prisma/client";
import { AppError, BadRequestError, NotFoundError } from "../../../common/errors.js";
import type { Env } from "../../../config/env.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import { razorpayCredentials } from "../../ludo/services/ludo-subscription-catalog.js";
import type {
  CoinPurchaseConfigDto,
  CoinPurchaseOrderDto,
  CoinPurchaseRecoveryDto,
  CoinPurchaseResultDto,
  CreateCoinPurchaseOrderInput,
  VerifyCoinPurchaseInput,
} from "../schemas/coin-purchase.schema.js";

interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
}

interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  captured: boolean;
}

interface RazorpayPaymentCollection {
  items: RazorpayPayment[];
}

export class CoinPurchaseService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly config: Env,
  ) {}

  async getConfig(): Promise<CoinPurchaseConfigDto> {
    const [enabled, priceRupees, coinsPerPack, maxPacks, credentials] = await Promise.all([
      this.settings.getBoolean("coinPurchase.enabled"),
      this.settings.getNumber("coinPurchase.packPriceRupees"),
      this.settings.getNumber("coinPurchase.coinsPerPack"),
      this.settings.getNumber("coinPurchase.maxPacks"),
      this.credentials(),
    ]);
    const configured = credentials !== null;
    return {
      enabled: enabled && configured,
      configured,
      priceRupees,
      coinsPerPack,
      maxPacks,
    };
  }

  async createOrder(
    userId: string,
    input: CreateCoinPurchaseOrderInput,
  ): Promise<CoinPurchaseOrderDto> {
    const purchaseConfig = await this.getConfig();
    if (!purchaseConfig.enabled) {
      throw new BadRequestError(
        purchaseConfig.configured
          ? "Add Coins is currently unavailable"
          : "Razorpay is not configured",
      );
    }
    if (input.packCount > purchaseConfig.maxPacks) {
      throw new BadRequestError(`You can buy at most ${purchaseConfig.maxPacks} packages at once`);
    }

    const amountPaise = purchaseConfig.priceRupees * input.packCount * 100;
    const coins = purchaseConfig.coinsPerPack * input.packCount;
    if (!Number.isSafeInteger(amountPaise) || !Number.isSafeInteger(coins)) {
      throw new BadRequestError("This coin package is too large");
    }

    const receipt = `coin_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const order = await this.razorpay<RazorpayOrder>("/orders", {
      method: "POST",
      body: {
        amount: amountPaise,
        currency: "INR",
        receipt,
        notes: { userId, purpose: "coin_purchase" },
      },
    });
    if (
      !order.id.startsWith("order_") ||
      order.amount !== amountPaise ||
      order.currency !== "INR"
    ) {
      throw new AppError("Razorpay returned an invalid order", 502, "PAYMENT_PROVIDER_ERROR");
    }

    const purchase = await this.prisma.coinPurchase.create({
      data: {
        userId,
        razorpayOrderId: order.id,
        amountPaise,
        coins,
        packCount: input.packCount,
      },
    });
    const credentials = await this.credentials();
    if (!credentials) {
      throw new AppError("Razorpay is not configured", 503, "PAYMENT_NOT_CONFIGURED");
    }
    return {
      purchaseId: purchase.id,
      orderId: purchase.razorpayOrderId,
      keyId: credentials.keyId,
      amountPaise,
      currency: "INR",
      coins,
      packCount: input.packCount,
      name: "Money Marathon",
      description: `${coins} coins`,
    };
  }

  async verify(userId: string, input: VerifyCoinPurchaseInput): Promise<CoinPurchaseResultDto> {
    const purchase = await this.prisma.coinPurchase.findUnique({
      where: { razorpayOrderId: input.orderId },
    });
    if (!purchase || purchase.userId !== userId) {
      throw new NotFoundError("Coin purchase order not found");
    }
    if (purchase.status === "CAPTURED") {
      return this.capturedResult(purchase);
    }
    await this.verifySignature(purchase.razorpayOrderId, input.paymentId, input.signature);

    let payment = await this.razorpay<RazorpayPayment>(
      `/payments/${encodeURIComponent(input.paymentId)}`,
      { method: "GET" },
    );
    this.assertPaymentMatches(payment, purchase);
    if (payment.status === "authorized") {
      payment = await this.razorpay<RazorpayPayment>(
        `/payments/${encodeURIComponent(input.paymentId)}/capture`,
        {
          method: "POST",
          body: { amount: purchase.amountPaise, currency: "INR" },
        },
      );
      this.assertPaymentMatches(payment, purchase);
    }
    if (payment.status !== "captured" || payment.captured !== true) {
      throw new BadRequestError("Payment is not captured yet. Please try again shortly.");
    }

    return this.completePurchase(purchase, input.paymentId);
  }

  /**
   * Recovery path for a checkout that succeeded just before the app closed or
   * lost connectivity. Razorpay is queried server-to-server, then the same
   * idempotent ledger transaction used by normal verification is applied.
   */
  async reconcile(userId: string): Promise<CoinPurchaseRecoveryDto> {
    if (!(await this.credentials())) return { recoveredPurchases: 0, coinsCredited: 0 };
    const pending = await this.prisma.coinPurchase.findMany({
      where: {
        userId,
        status: "CREATED",
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    let recoveredPurchases = 0;
    let coinsCredited = 0;
    for (const purchase of pending) {
      let collection: RazorpayPaymentCollection;
      try {
        collection = await this.razorpay<RazorpayPaymentCollection>(
          `/orders/${encodeURIComponent(purchase.razorpayOrderId)}/payments`,
          { method: "GET" },
        );
      } catch {
        continue;
      }
      let payment = collection.items.find(
        (candidate) => candidate.status === "captured" || candidate.status === "authorized",
      );
      if (!payment) continue;
      try {
        this.assertPaymentMatches(payment, purchase);
        if (payment.status === "authorized") {
          payment = await this.razorpay<RazorpayPayment>(
            `/payments/${encodeURIComponent(payment.id)}/capture`,
            {
              method: "POST",
              body: { amount: purchase.amountPaise, currency: "INR" },
            },
          );
          this.assertPaymentMatches(payment, purchase);
        }
        if (payment.status !== "captured" || payment.captured !== true) continue;
        const result = await this.completePurchase(purchase, payment.id);
        recoveredPurchases += 1;
        coinsCredited += result.coinsCredited;
      } catch {
        // One stale/failed order must not block recovery of the others.
      }
    }
    return { recoveredPurchases, coinsCredited };
  }

  private async completePurchase(
    purchase: CoinPurchase,
    paymentId: string,
  ): Promise<CoinPurchaseResultDto> {
    const userId = purchase.userId;
    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.coinPurchase.updateMany({
        where: { id: purchase.id, userId, status: "CREATED" },
        data: {
          status: "CAPTURED",
          razorpayPaymentId: paymentId,
          capturedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        const existing = await tx.coinPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
        const wallet = await tx.wallet.upsert({
          where: { userId },
          create: { userId },
          update: {},
        });
        return {
          purchaseId: existing.id,
          status: "CAPTURED" as const,
          coinsCredited: existing.coins,
          balance: wallet.balance.toNumber(),
          newlyCaptured: false,
        };
      }

      const wallet = await tx.wallet.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: purchase.coins } },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "CREDIT",
          amount: purchase.coins,
          balanceAfter: updatedWallet.balance,
          reference: `coin-purchase:${purchase.id}`,
          description: "Coins added via Razorpay",
        },
      });
      return {
        purchaseId: purchase.id,
        status: "CAPTURED" as const,
        coinsCredited: purchase.coins,
        balance: updatedWallet.balance.toNumber(),
        newlyCaptured: true,
      };
    });

    if (result.newlyCaptured) {
      await this.notifications.enqueue({
        audience: "user",
        userId,
        type: "WALLET",
        title: "Coins added",
        body: `${result.coinsCredited} coins were added to your wallet.`,
        route: "/wallet",
      });
    }
    return {
      purchaseId: result.purchaseId,
      status: result.status,
      coinsCredited: result.coinsCredited,
      balance: result.balance,
    };
  }

  private async capturedResult(purchase: CoinPurchase): Promise<CoinPurchaseResultDto> {
    const wallet = await this.prisma.wallet.upsert({
      where: { userId: purchase.userId },
      create: { userId: purchase.userId },
      update: {},
    });
    return {
      purchaseId: purchase.id,
      status: "CAPTURED",
      coinsCredited: purchase.coins,
      balance: wallet.balance.toNumber(),
    };
  }

  private async verifySignature(
    orderId: string,
    paymentId: string,
    received: string,
  ): Promise<void> {
    const credentials = await this.credentials();
    if (!credentials) {
      throw new AppError("Razorpay is not configured", 503, "PAYMENT_NOT_CONFIGURED");
    }
    const expected = createHmac("sha256", credentials.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest();
    const actual = Buffer.from(received, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new BadRequestError("Payment verification failed");
    }
  }

  private assertPaymentMatches(payment: RazorpayPayment, purchase: CoinPurchase): void {
    if (
      payment.id.length === 0 ||
      payment.order_id !== purchase.razorpayOrderId ||
      payment.amount !== purchase.amountPaise ||
      payment.currency !== "INR"
    ) {
      throw new BadRequestError("Payment details do not match this coin order");
    }
  }

  private async credentials(): Promise<{ keyId: string; keySecret: string } | null> {
    const [settingKeyId, settingKeySecret] = await Promise.all([
      this.settings.getString("payment.razorpay.keyId"),
      this.settings.getString("payment.razorpay.keySecret"),
    ]);
    return razorpayCredentials(this.config, {
      keyId: settingKeyId,
      keySecret: settingKeySecret,
    });
  }

  private async razorpay<T>(
    path: string,
    options: { method: "GET" | "POST"; body?: Record<string, unknown> },
  ): Promise<T> {
    const credentials = await this.credentials();
    if (!credentials) {
      throw new AppError("Razorpay is not configured", 503, "PAYMENT_NOT_CONFIGURED");
    }
    const response = await fetch(`${this.config.RAZORPAY_API_BASE_URL}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${credentials.keyId}:${credentials.keySecret}`,
        ).toString("base64")}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new AppError(
        "Could not reach Razorpay. Please try again.",
        502,
        "PAYMENT_PROVIDER_UNAVAILABLE",
      );
    });
    const payload = (await response.json().catch(() => null)) as T | null;
    if (!response.ok || payload === null) {
      throw new AppError("Razorpay could not process this request", 502, "PAYMENT_PROVIDER_ERROR");
    }
    return payload;
  }
}
