import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "../../../common/errors.js";
import { buildMeta } from "../../../common/pagination.js";
import type { PageMeta } from "../../../common/response.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import {
  toCompletionDto,
  toMissionDto,
  type CompletionDto,
  type ListCompletionsQuery,
  type MissionDto,
  type ReviewCompletionInput,
  type UpdateMissionInput,
  type UpsertMissionInput,
  type UserMissionDto,
} from "../schemas/missions.schema.js";

// List/review DTOs need only these fields. Avoid transferring long mission
// descriptions and private user columns on every admin queue row.
const completionInclude = {
  mission: { select: { title: true, rewardCoins: true } },
  user: { select: { email: true } },
} as const;

// ponytail: queries are simple enough to live here, prisma used directly — split out a repository if they grow.
export class MissionsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationsService,
  ) {}

  // ---- user ----

  /** Published missions with the caller's completion status merged in. */
  async listPublished(userId: string): Promise<UserMissionDto[]> {
    const [missions, mine] = await Promise.all([
      this.prisma.mission.findMany({
        where: { status: "PUBLISHED", deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      }),
      this.prisma.missionCompletion.findMany({
        where: { userId, mission: { status: "PUBLISHED", deletedAt: null } },
        select: { missionId: true, status: true },
      }),
    ]);
    const byMission = new Map(mine.map((c) => [c.missionId, c.status]));
    return missions.map((mission) => ({
      ...toMissionDto(mission),
      myCompletionStatus: byMission.get(mission.id) ?? null,
    }));
  }

  async complete(userId: string, missionId: string): Promise<CompletionDto> {
    const mission = await this.prisma.mission.findFirst({
      where: { id: missionId, status: "PUBLISHED", deletedAt: null },
    });
    if (!mission) throw new NotFoundError("Mission not found");

    const existing = await this.prisma.missionCompletion.findUnique({
      where: { missionId_userId: { missionId, userId } },
    });
    if (existing) throw new ConflictError("You have already submitted this mission");

    const completion = await this.prisma.missionCompletion.create({
      data: { missionId, userId },
      include: completionInclude,
    });
    return toCompletionDto(completion);
  }

  async listMine(userId: string): Promise<CompletionDto[]> {
    const completions = await this.prisma.missionCompletion.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: completionInclude,
    });
    return completions.map(toCompletionDto);
  }

  // ---- admin ----

  async listAll(): Promise<MissionDto[]> {
    const missions = await this.prisma.mission.findMany({
      where: { deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    });
    return missions.map(toMissionDto);
  }

  async create(input: UpsertMissionInput): Promise<MissionDto> {
    const mission = await this.prisma.mission.create({
      data: { ...input, rewardCoins: new Prisma.Decimal(input.rewardCoins) },
    });
    return toMissionDto(mission);
  }

  async update(id: string, input: UpdateMissionInput): Promise<MissionDto> {
    const existing = await this.prisma.mission.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError("Mission not found");
    const mission = await this.prisma.mission.update({
      where: { id },
      data: {
        ...input,
        rewardCoins:
          input.rewardCoins === undefined ? undefined : new Prisma.Decimal(input.rewardCoins),
      },
    });
    return toMissionDto(mission);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.prisma.mission.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError("Mission not found");
    await this.prisma.mission.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async listCompletions(
    query: ListCompletionsQuery,
  ): Promise<{ items: CompletionDto[]; meta: PageMeta }> {
    const where = query.status ? { status: query.status } : {};
    const [completions, total] = await Promise.all([
      this.prisma.missionCompletion.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: { createdAt: "desc" },
        include: completionInclude,
      }),
      this.prisma.missionCompletion.count({ where }),
    ]);
    return {
      items: completions.map(toCompletionDto),
      meta: buildMeta({ page: query.page, limit: query.limit }, total),
    };
  }

  /** Mirrors claims review: approve = wallet credit + notification in one transaction. */
  async review(
    completionId: string,
    reviewerId: string,
    input: ReviewCompletionInput,
  ): Promise<CompletionDto> {
    const completion = await this.prisma.missionCompletion.findUnique({
      where: { id: completionId },
      include: completionInclude,
    });
    if (!completion) throw new NotFoundError("Completion not found");
    if (completion.status !== "PENDING") {
      throw new ConflictError(`Completion has already been ${completion.status.toLowerCase()}`);
    }

    const reviewData = {
      note: input.note,
      reviewedById: reviewerId,
      reviewedAt: new Date(),
    };

    if (input.action === "REJECT") {
      const marked = await this.prisma.missionCompletion.updateMany({
        where: { id: completionId, status: "PENDING" },
        data: { status: "REJECTED", ...reviewData },
      });
      if (marked.count === 0) {
        throw new ConflictError("Completion has already been reviewed");
      }
      await this.notifications.enqueue({
        userId: completion.userId,
        type: "SYSTEM",
        title: "Mission rejected",
        body: `Your submission for "${completion.mission.title}" was rejected.`,
      });
    } else {
      const reward = completion.mission.rewardCoins;
      await this.prisma.$transaction(async (tx) => {
        const marked = await tx.missionCompletion.updateMany({
          where: { id: completionId, status: "PENDING" },
          data: { status: "APPROVED", ...reviewData },
        });
        if (marked.count === 0) {
          throw new ConflictError("Completion has already been reviewed");
        }
        const wallet = await tx.wallet.upsert({
          where: { userId: completion.userId },
          create: { userId: completion.userId },
          update: {},
        });
        const after = await tx.wallet.update({
          where: { id: wallet.id },
          data: { balance: { increment: reward } },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: "CREDIT",
            amount: new Prisma.Decimal(reward),
            balanceAfter: after.balance,
            reference: `mission:${completion.id}`,
            description: `Reward for mission "${completion.mission.title}"`,
          },
        });
      });
      await this.notifications.enqueue({
        userId: completion.userId,
        type: "WALLET",
        title: "Mission reward credited",
        body: `Your submission for "${completion.mission.title}" was approved and ${reward.toFixed(2)} coins were credited to your wallet.`,
      });
    }

    const refreshed = await this.prisma.missionCompletion.findUnique({
      where: { id: completionId },
      include: completionInclude,
    });
    return toCompletionDto(refreshed!);
  }
}
