import { BadRequestError, ConflictError, NotFoundError } from "../../../common/errors.js";
import { buildMeta, toSkipTake } from "../../../common/pagination.js";
import type { PageMeta } from "../../../common/response.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import type { NotificationJob } from "../../notifications/queues/notification.queue.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import type { RedemptionsRepository } from "../repositories/redemptions.repository.js";
import type { VoucherProviderRegistry } from "../providers/voucher-provider-registry.js";
import {
  toRedemptionDto,
  toVoucherOfferDto,
  type AdminListRedemptionsQuery,
  type CreateRedemptionInput,
  type CreateVoucherOfferInput,
  type FulfillRedemptionInput,
  type ListMineQuery,
  type MarkPaidInput,
  type RedemptionConfigDto,
  type RedemptionDto,
  type ReviewRedemptionInput,
  type UpdateVoucherOfferInput,
  type VoucherOfferDto,
} from "../schemas/redemptions.schema.js";

export class RedemptionsService {
  constructor(
    private readonly repo: RedemptionsRepository,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    /** Resolves the voucher provider per catalog item from current settings;
     *  returns null (manual fulfillment) when Xoxoday isn't configured. */
    private readonly providers: VoucherProviderRegistry,
  ) {}

  async getConfig(): Promise<RedemptionConfigDto> {
    const [enabled, minCoins, upiEnabled, coinsPerRupee, upiMinCoins] = await Promise.all([
      this.settings.getBoolean("redeem.enabled"),
      this.settings.getNumber("redeem.minCoins"),
      this.settings.getBoolean("redeem.upi.enabled"),
      this.settings.getNumber("redeem.upi.coinsPerRupee"),
      this.settings.getNumber("redeem.upi.minCoins"),
    ]);
    return {
      enabled,
      minCoins,
      upi: { enabled: enabled && upiEnabled, coinsPerRupee, minCoins: upiMinCoins },
    };
  }

  /** Admin: current Xoxoday reward-provider status (never returns secrets). */
  providerStatus(): ReturnType<VoucherProviderRegistry["status"]> {
    return this.providers.status();
  }

  /** Admin "Test connection": verify the configured Xoxoday credentials. */
  testProvider(): ReturnType<VoucherProviderRegistry["test"]> {
    return this.providers.test();
  }

  /** User requests a redemption: coins are debited immediately (escrow). */
  async request(userId: string, input: CreateRedemptionInput): Promise<RedemptionDto> {
    const config = await this.getConfig();
    if (!config.enabled) throw new BadRequestError("Redemptions are currently disabled");

    if (input.method === "UPI") {
      if (!config.upi.enabled) throw new BadRequestError("UPI payouts are currently disabled");
      const coins = input.coins!;
      if (coins < config.upi.minCoins) {
        throw new BadRequestError(`Minimum UPI payout is ${config.upi.minCoins} coins`);
      }
      const upiId = input.upiId ?? (await this.repo.findUserUpiId(userId));
      if (!upiId) throw new BadRequestError("Add your UPI ID before requesting a payout");
      // Rupee value is snapshotted at today's rate so a later rate change
      // never alters what an already-submitted request is worth.
      const amountInr = Math.round((coins / config.upi.coinsPerRupee) * 100) / 100;
      if (amountInr < 1) {
        throw new BadRequestError("This payout is below ₹1 — redeem more coins");
      }
      const redemption = await this.repo.createRequest(userId, coins, {
        method: "UPI",
        upiId,
        amountInr,
      });
      return toRedemptionDto(redemption);
    }

    let coins: number;
    let voucherOfferId: string | undefined;
    if (input.voucherOfferId) {
      const offer = await this.repo.findOfferById(input.voucherOfferId);
      if (!offer || !offer.isActive) throw new NotFoundError("Voucher offer not found");
      coins = offer.coinCost;
      voucherOfferId = offer.id;
    } else {
      coins = input.coins!;
      if (coins < config.minCoins) {
        throw new BadRequestError(`Minimum redemption is ${config.minCoins} coins`);
      }
    }

    // One-pending rule + balance check + debit all inside the transaction.
    const redemption = await this.repo.createRequest(userId, coins, { voucherOfferId });
    return toRedemptionDto(redemption);
  }

  async listMine(
    userId: string,
    query: ListMineQuery,
  ): Promise<{ items: RedemptionDto[]; meta: PageMeta }> {
    const [items, total] = await this.repo.listByUser(userId, {
      ...toSkipTake(query),
      status: query.status,
    });
    return { items: items.map((r) => toRedemptionDto(r)), meta: buildMeta(query, total) };
  }

  async listAdmin(
    query: AdminListRedemptionsQuery,
  ): Promise<{ items: RedemptionDto[]; meta: PageMeta }> {
    const [items, total] = await this.repo.listAdmin({
      ...toSkipTake(query),
      status: query.status,
      method: query.method,
      userId: query.userId,
      search: query.search,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    return { items: items.map((r) => toRedemptionDto(r, true)), meta: buildMeta(query, total) };
  }

  /**
   * Admin review. REJECT refunds the coins. APPROVE persists the approval
   * FIRST, then tries the provider (FULFILLED on success, stays APPROVED +
   * failReason on failure) — so a provider-issued voucher can never be lost
   * to a later DB write failing, and a crash mid-flow is re-fulfillable
   * manually instead of re-issuable.
   */
  async review(
    id: string,
    reviewerId: string,
    input: ReviewRedemptionInput,
  ): Promise<RedemptionDto> {
    const redemption = await this.repo.findById(id);
    if (!redemption) throw new NotFoundError("Redemption not found");
    if (redemption.status !== "PENDING") {
      throw new ConflictError(`Redemption has already been ${redemption.status.toLowerCase()}`);
    }
    // A UPI request must never enter the voucher-provider path; it is settled
    // with mark-paid after the admin actually sends the money.
    if (redemption.method === "UPI" && input.action === "APPROVE") {
      throw new BadRequestError(
        "UPI payout requests are settled with mark-paid after sending the money",
      );
    }

    if (input.action === "REJECT") {
      const rejected = await this.repo.rejectWithRefund(id, reviewerId, input.note ?? null);
      await this.safeNotify({
        userId: rejected.userId,
        type: "SYSTEM",
        title: "Redemption rejected",
        body: `Your redemption of ${Number(rejected.coins)} coins was rejected and the coins were refunded to your wallet.${
          input.note ? ` ${input.note}` : ""
        }`,
        route: "/wallet",
      });
      return toRedemptionDto(rejected, true);
    }

    // Persist the approval before any provider side effect (guarded: loses
    // cleanly if another admin already reviewed the row).
    const approved = await this.repo.guardedUpdate(id, ["PENDING"], {
      status: "APPROVED",
      note: input.note ?? null,
      reviewedById: reviewerId,
      reviewedAt: new Date(),
    });

    // A catalog item marked "manual" skips auto-issue even when Xoxoday is
    // configured; a Xoxoday item dispatches to its provider ("plum" = reward
    // link, "xoxo_code" = gift-card code). Legacy amount-only rows keep the
    // historical behavior of using the reward-link provider + default campaign.
    const offer = approved.voucherOfferId
      ? await this.repo.findOfferById(approved.voucherOfferId)
      : null;
    const providerName = offer ? offer.provider : "plum";
    const provider = await this.providers.resolve(providerName);
    if (!provider) return toRedemptionDto(approved, true);

    // Only the provider call may be treated as a provider failure — once a
    // voucher is issued, real money exists and must never be silently lost.
    let voucher;
    try {
      voucher = await provider.issueVoucher({
        amount: offer ? Number(offer.denomination) : Number(approved.coins),
        campaignId: offer?.providerBrandId ?? undefined,
        userEmail: approved.user.email,
        redemptionId: approved.id,
      });
    } catch (error) {
      // Provider failed — keep the approval, queue for manual fulfillment.
      const reason = error instanceof Error ? error.message : String(error);
      const parked = await this.repo.guardedUpdate(id, ["APPROVED"], {
        provider: provider.name,
        failReason: reason.slice(0, 1000),
      });
      return toRedemptionDto(parked, true);
    }

    try {
      const fulfilled = await this.repo.guardedUpdate(id, ["APPROVED"], {
        status: "FULFILLED",
        provider: provider.name,
        voucherCode: voucher.code ?? null,
        voucherUrl: voucher.url ?? null,
        providerRef: voucher.ref ?? null,
        failReason: null,
      });
      await this.notifyFulfilled(fulfilled.userId);
      return toRedemptionDto(fulfilled, true);
    } catch (persistError) {
      // The voucher IS issued but couldn't be recorded (transient DB error,
      // or a concurrent manual fulfill won the race). Log it, then park the
      // code in failReason on whatever state the row is in so an admin can
      // reconcile instead of paying out twice.
      console.error(
        `[redemptions] issued reward NOT persisted for redemption ${id}` +
          `${voucher.ref ? ` ref=${voucher.ref}` : ""} — reconcile manually`,
        persistError,
      );
      try {
        const parked = await this.repo.guardedUpdate(id, ["APPROVED", "FULFILLED"], {
          failReason:
            (`Auto-issued reward needs reconciliation` +
            `${voucher.ref ? `: ref=${voucher.ref}` : ""}`).slice(0, 1000),
        });
        return toRedemptionDto(parked, true);
      } catch {
        throw persistError; // already logged with the voucher code above
      }
    }
  }

  /**
   * Claim a UPI payout before actually sending the money: guarded
   * PENDING -> APPROVED. While claimed, reject (and its refund) is impossible,
   * closing the race where admin A pays out-of-band and admin B rejects
   * before A can mark paid — refunding the coins after real money left.
   * release() undoes an unpaid claim.
   */
  async claim(id: string, reviewerId: string): Promise<RedemptionDto> {
    const redemption = await this.repo.findById(id);
    if (!redemption) throw new NotFoundError("Redemption not found");
    if (redemption.method !== "UPI") {
      throw new BadRequestError("Only UPI payout requests can be claimed");
    }
    const claimed = await this.repo.guardedUpdate(id, ["PENDING"], {
      status: "APPROVED",
      reviewedById: reviewerId,
      reviewedAt: new Date(),
    });
    return toRedemptionDto(claimed, true);
  }

  /** Put a claimed-but-unpaid UPI payout back in the PENDING queue. */
  async release(id: string): Promise<RedemptionDto> {
    const redemption = await this.repo.findById(id);
    if (!redemption) throw new NotFoundError("Redemption not found");
    if (redemption.method !== "UPI") {
      throw new BadRequestError("Only UPI payout requests can be released");
    }
    const released = await this.repo.guardedUpdate(id, ["APPROVED"], {
      status: "PENDING",
      reviewedById: null,
      reviewedAt: null,
    });
    return toRedemptionDto(released, true);
  }

  /**
   * Super admin confirms a UPI payout was sent (after paying via the QR /
   * UPI ID from the admin panel). Guarded PENDING/APPROVED -> FULFILLED so
   * two admins can't both settle the same request; the UTR lands in
   * providerRef. APPROVED here means "claimed via claim()", never the voucher
   * approval state — review() refuses APPROVE on UPI rows.
   */
  async markPaid(id: string, reviewerId: string, input: MarkPaidInput): Promise<RedemptionDto> {
    const redemption = await this.repo.findById(id);
    if (!redemption) throw new NotFoundError("Redemption not found");
    if (redemption.method !== "UPI") {
      throw new BadRequestError("Only UPI payout requests can be marked paid");
    }

    const paid = await this.repo.guardedUpdate(id, ["PENDING", "APPROVED"], {
      status: "FULFILLED",
      provider: "upi",
      providerRef: input.paymentRef ?? null,
      note: input.note ?? null,
      failReason: null,
      reviewedById: reviewerId,
      reviewedAt: new Date(),
    });
    await this.safeNotify({
      userId: paid.userId,
      type: "WALLET",
      title: "UPI payout sent 💸",
      body: `₹${Number(paid.amountInr ?? 0).toFixed(2)} for ${Number(paid.coins)} coins has been sent to your UPI ID.`,
      route: "/redeem/history",
    });
    return toRedemptionDto(paid, true);
  }

  /** Super admin manually attaches a voucher to an APPROVED redemption. */
  async fulfill(
    id: string,
    reviewerId: string,
    input: FulfillRedemptionInput,
  ): Promise<RedemptionDto> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundError("Redemption not found");
    // A claimed UPI payout is also APPROVED — never let a voucher code settle it.
    if (existing.method === "UPI") {
      throw new BadRequestError("UPI payout requests are settled with mark-paid");
    }
    const fulfilled = await this.repo.guardedUpdate(id, ["APPROVED"], {
      status: "FULFILLED",
      provider: "manual",
      voucherCode: input.voucherCode,
      voucherUrl: input.voucherUrl ?? null,
      failReason: null,
      reviewedById: reviewerId,
      reviewedAt: new Date(),
    });
    await this.notifyFulfilled(fulfilled.userId);
    return toRedemptionDto(fulfilled, true);
  }

  // ---- Voucher catalog ----

  async listCatalog(): Promise<VoucherOfferDto[]> {
    return (await this.repo.listOffers(true)).map(toVoucherOfferDto);
  }

  async listCatalogAdmin(): Promise<VoucherOfferDto[]> {
    return (await this.repo.listOffers(false)).map(toVoucherOfferDto);
  }

  async createOffer(input: CreateVoucherOfferInput): Promise<VoucherOfferDto> {
    return toVoucherOfferDto(
      await this.repo.createOffer({
        ...input,
        description: input.description ?? null,
        imageUrl: input.imageUrl ?? null,
        providerBrandId: input.providerBrandId ?? null,
      }),
    );
  }

  async updateOffer(id: string, input: UpdateVoucherOfferInput): Promise<VoucherOfferDto> {
    const existing = await this.repo.findOfferById(id);
    if (!existing) throw new NotFoundError("Voucher offer not found");
    return toVoucherOfferDto(await this.repo.updateOffer(id, input));
  }

  async deleteOffer(id: string): Promise<void> {
    const existing = await this.repo.findOfferById(id);
    if (!existing) throw new NotFoundError("Voucher offer not found");
    await this.repo.deleteOffer(id);
  }

  /** Voucher codes stay OUT of push bodies (lock screens); route to My Coupons. */
  private notifyFulfilled(userId: string): Promise<void> {
    return this.safeNotify({
      userId,
      type: "WALLET",
      title: "Your voucher is ready 🎁",
      body: "Your redemption is complete — open My Coupons to view your voucher.",
      route: "/coupons",
    });
  }

  /** Best-effort: a Redis outage must never 500 an already-committed review. */
  private async safeNotify(input: NotificationJob): Promise<void> {
    try {
      await this.notifications.enqueue(input);
    } catch {
      /* push is best-effort */
    }
  }
}
