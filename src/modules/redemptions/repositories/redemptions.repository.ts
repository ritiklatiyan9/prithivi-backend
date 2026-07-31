import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  RedemptionMethod,
  RedemptionStatus,
  VoucherOffer,
} from "@prisma/client";
import { BadRequestError, ConflictError } from "../../../common/errors.js";
import type { RedemptionWithOffer, RedemptionWithUser } from "../schemas/redemptions.schema.js";

const OFFER_SELECT = {
  select: { id: true, title: true, brand: true, imageUrl: true, denomination: true },
} as const;

const INCLUDE_ALL = {
  user: { select: { id: true, name: true, email: true } },
  voucherOffer: OFFER_SELECT,
} as const;

export class RedemptionsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<RedemptionWithUser | null> {
    return this.prisma.redemption.findUnique({ where: { id }, include: INCLUDE_ALL });
  }

  /** The user's saved UPI VPA, if any. */
  async findUserUpiId(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { upiId: true },
    });
    return user?.upiId ?? null;
  }

  /**
   * Atomically: enforce the one-pending rule, re-check balance, debit the
   * wallet and create the PENDING redemption. All guards live inside the
   * transaction so concurrent requests can't double-spend or double-submit.
   * UPI payouts snapshot the VPA + rupee value on the row and save the VPA as
   * the user's default for next time.
   */
  createRequest(
    userId: string,
    coins: number,
    opts: {
      voucherOfferId?: string;
      method?: "VOUCHER" | "UPI";
      upiId?: string;
      amountInr?: number;
    } = {},
  ): Promise<RedemptionWithOffer> {
    const method = opts.method ?? "VOUCHER";
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
      // The upsert's forced UPDATE (@updatedAt) row-locks the wallet, so the
      // pending-count check below is serialized per user.
      const pending = await tx.redemption.count({ where: { userId, status: "PENDING" } });
      if (pending > 0) {
        throw new ConflictError("You already have a pending redemption request");
      }
      if (wallet.balance.lessThan(coins)) {
        throw new BadRequestError("Insufficient wallet balance");
      }

      const redemption = await tx.redemption.create({
        data: {
          userId,
          coins: new Prisma.Decimal(coins),
          voucherOfferId: opts.voucherOfferId ?? null,
          method,
          upiId: opts.upiId ?? null,
          amountInr:
            opts.amountInr !== undefined ? new Prisma.Decimal(opts.amountInr.toFixed(2)) : null,
        },
        include: { voucherOffer: OFFER_SELECT },
      });

      if (method === "UPI" && opts.upiId) {
        await tx.user.update({ where: { id: userId }, data: { upiId: opts.upiId } });
      }

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: coins } },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "DEBIT",
          amount: new Prisma.Decimal(coins),
          balanceAfter: updated.balance,
          reference: `redemption:${redemption.id}`,
          description: method === "UPI" ? "UPI payout request" : "Redemption request",
        },
      });

      return redemption;
    });
  }

  /**
   * Atomically: mark REJECTED and refund the debited coins. The guarded
   * updateMany (status must still be PENDING) makes racing reviews lose
   * cleanly instead of double-refunding.
   */
  rejectWithRefund(id: string, reviewerId: string, note: string | null): Promise<RedemptionWithUser> {
    return this.prisma.$transaction(async (tx) => {
      const marked = await tx.redemption.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "REJECTED", note, reviewedById: reviewerId, reviewedAt: new Date() },
      });
      if (marked.count === 0) {
        throw new ConflictError("Redemption has already been reviewed");
      }
      const redemption = await tx.redemption.findUniqueOrThrow({
        where: { id },
        include: INCLUDE_ALL,
      });

      const wallet = await tx.wallet.upsert({
        where: { userId: redemption.userId },
        create: { userId: redemption.userId },
        update: {},
      });
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: redemption.coins } },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "CREDIT",
          amount: new Prisma.Decimal(redemption.coins),
          balanceAfter: updated.balance,
          reference: `redemption-refund:${redemption.id}`,
          description: "Redemption refund",
        },
      });

      return redemption;
    });
  }

  /**
   * Review/fulfil state changes that don't touch the wallet, guarded so the
   * row must still be in one of `fromStatuses` — a racing update loses with a
   * conflict instead of clobbering.
   */
  async guardedUpdate(
    id: string,
    fromStatuses: RedemptionStatus[],
    data: Prisma.RedemptionUncheckedUpdateManyInput,
  ): Promise<RedemptionWithUser> {
    const marked = await this.prisma.redemption.updateMany({
      where: { id, status: { in: fromStatuses } },
      data,
    });
    if (marked.count === 0) {
      throw new ConflictError("Redemption has already been reviewed");
    }
    return this.prisma.redemption.findUniqueOrThrow({ where: { id }, include: INCLUDE_ALL });
  }

  listByUser(
    userId: string,
    params: { skip: number; take: number; status?: RedemptionStatus },
  ): Promise<[RedemptionWithOffer[], number]> {
    const where: Prisma.RedemptionWhereInput = {
      userId,
      ...(params.status ? { status: params.status } : {}),
    };
    return Promise.all([
      this.prisma.redemption.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: "desc" },
        include: { voucherOffer: OFFER_SELECT },
      }),
      this.prisma.redemption.count({ where }),
    ]);
  }

  listAdmin(params: {
    skip: number;
    take: number;
    status?: RedemptionStatus;
    method?: RedemptionMethod;
    userId?: string;
    search?: string;
    from?: Date;
    to?: Date;
  }): Promise<[RedemptionWithUser[], number]> {
    const where: Prisma.RedemptionWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.method ? { method: params.method } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.search
        ? { user: { email: { contains: params.search, mode: "insensitive" } } }
        : {}),
      ...(params.from || params.to
        ? { createdAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
    };
    return Promise.all([
      this.prisma.redemption.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: "desc" },
        include: INCLUDE_ALL,
      }),
      this.prisma.redemption.count({ where }),
    ]);
  }

  // ---- Voucher catalog ----

  listOffers(activeOnly: boolean): Promise<VoucherOffer[]> {
    return this.prisma.voucherOffer.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: [{ sortOrder: "asc" }, { coinCost: "asc" }],
    });
  }

  findOfferById(id: string): Promise<VoucherOffer | null> {
    return this.prisma.voucherOffer.findUnique({ where: { id } });
  }

  createOffer(data: Prisma.VoucherOfferUncheckedCreateInput): Promise<VoucherOffer> {
    return this.prisma.voucherOffer.create({ data });
  }

  updateOffer(id: string, data: Prisma.VoucherOfferUncheckedUpdateInput): Promise<VoucherOffer> {
    return this.prisma.voucherOffer.update({ where: { id }, data });
  }

  /** Hard delete only when nothing references the offer; else 409 — deactivate
   *  instead. The FK is onDelete: Restrict, so a redemption created between
   *  the count and the delete makes the delete throw P2003 instead of
   *  silently stripping attribution. */
  async deleteOffer(id: string): Promise<void> {
    const used = await this.prisma.redemption.count({ where: { voucherOfferId: id } });
    if (used > 0) {
      throw new ConflictError(
        "This offer has redemptions attached — deactivate it instead of deleting",
      );
    }
    try {
      await this.prisma.voucherOffer.delete({ where: { id } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2003"
      ) {
        throw new ConflictError(
          "This offer has redemptions attached — deactivate it instead of deleting",
        );
      }
      throw error;
    }
  }
}
