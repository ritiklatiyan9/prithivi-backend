import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { BadRequestError, ConflictError, NotFoundError } from "../../../common/errors.js";
import { buildMeta, type PaginationQuery } from "../../../common/pagination.js";
import type { PageMeta } from "../../../common/response.js";
import type { CampaignRepository } from "../../campaign/repositories/campaign.repository.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import type { ClaimsRepository } from "../repositories/claims.repository.js";
import {
  toClaimDto,
  type ClaimDto,
  type ListClaimsQuery,
  type ReviewClaimInput,
  type SubmitClaimInput,
} from "../schemas/claims.schema.js";

export class ClaimsService {
  constructor(
    // Injected for cross-aggregate transactions (claim + wallet must commit together).
    private readonly prisma: PrismaClient,
    private readonly claims: ClaimsRepository,
    private readonly campaigns: CampaignRepository,
    private readonly notifications: NotificationsService,
  ) {}

  async submit(userId: string, input: SubmitClaimInput): Promise<ClaimDto> {
    const campaign = await this.campaigns.findById(input.campaignId);
    if (!campaign) throw new NotFoundError("Campaign not found");
    if (campaign.status !== "ACTIVE") {
      throw new BadRequestError("Claims can only be submitted for active campaigns");
    }

    const now = new Date();
    if (campaign.startsAt && campaign.startsAt > now) {
      throw new BadRequestError("Campaign has not started yet");
    }
    if (campaign.endsAt && campaign.endsAt < now) {
      throw new BadRequestError("Campaign has already ended");
    }

    const existing = await this.claims.findByUserAndCampaign(userId, input.campaignId);
    if (existing) {
      throw new ConflictError("You have already submitted a claim for this campaign");
    }

    const claim = await this.claims.create({
      campaignId: input.campaignId,
      userId,
      rewardAmount: campaign.rewardAmount,
      note: input.note,
    });

    const withRelations = await this.claims.findById(claim.id);
    return toClaimDto(withRelations!);
  }

  async review(claimId: string, reviewerId: string, input: ReviewClaimInput): Promise<ClaimDto> {
    const claim = await this.claims.findById(claimId);
    if (!claim) throw new NotFoundError("Claim not found");
    if (claim.status !== "PENDING") {
      throw new ConflictError(`Claim has already been ${claim.status.toLowerCase()}`);
    }

    if (input.action === "REJECT") {
      const marked = await this.prisma.claim.updateMany({
        where: { id: claimId, status: "PENDING" },
        data: {
          status: "REJECTED",
          reviewNote: input.reviewNote,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
        },
      });
      if (marked.count === 0) {
        throw new ConflictError("Claim has already been reviewed");
      }

      await this.notifications.enqueue({
        userId: claim.userId,
        type: "CLAIM",
        title: "Claim rejected",
        body: `Your claim for "${claim.campaign.title}" was rejected.`,
      });
    } else {
      // Approve + credit the wallet atomically.
      await this.prisma.$transaction(async (tx) => {
        const marked = await tx.claim.updateMany({
          where: { id: claimId, status: "PENDING" },
          data: {
            status: "APPROVED",
            reviewNote: input.reviewNote,
            reviewedById: reviewerId,
            reviewedAt: new Date(),
          },
        });
        if (marked.count === 0) {
          throw new ConflictError("Claim has already been reviewed");
        }

        const wallet = await tx.wallet.upsert({
          where: { userId: claim.userId },
          create: { userId: claim.userId },
          update: {},
        });

        const updated = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: claim.rewardAmount } },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: "CREDIT",
            amount: new Prisma.Decimal(claim.rewardAmount),
            balanceAfter: updated.balance,
            reference: `claim:${claim.id}`,
            description: `Reward for campaign "${claim.campaign.title}"`,
          },
        });
      });

      await this.notifications.enqueue({
        userId: claim.userId,
        type: "WALLET",
        title: "Reward credited",
        body: `Your claim for "${claim.campaign.title}" was approved and ${claim.rewardAmount.toFixed(2)} was credited to your wallet.`,
      });
    }

    const refreshed = await this.claims.findById(claimId);
    return toClaimDto(refreshed!);
  }

  async listMine(
    userId: string,
    query: ListClaimsQuery,
  ): Promise<{ items: ClaimDto[]; meta: PageMeta }> {
    const pagination: PaginationQuery = { page: query.page, limit: query.limit };
    const [claims, total] = await this.claims.listByUser(userId, {
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      status: query.status,
    });
    return { items: claims.map(toClaimDto), meta: buildMeta(pagination, total) };
  }

  async listAll(query: ListClaimsQuery): Promise<{ items: ClaimDto[]; meta: PageMeta }> {
    const pagination: PaginationQuery = { page: query.page, limit: query.limit };
    const [claims, total] = await this.claims.list({
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      status: query.status,
    });
    return { items: claims.map(toClaimDto), meta: buildMeta(pagination, total) };
  }
}
