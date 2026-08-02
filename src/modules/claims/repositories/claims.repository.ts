import type { Claim, ClaimStatus, Prisma, PrismaClient } from "@prisma/client";

export type ClaimWithRelations = Claim & {
  campaign: { title: string };
  user: { email: string };
};

const CLAIM_RELATIONS = {
  campaign: { select: { title: true } },
  user: { select: { email: true } },
} as const;

export class ClaimsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: Prisma.ClaimUncheckedCreateInput): Promise<Claim> {
    return this.prisma.claim.create({ data });
  }

  findById(id: string): Promise<ClaimWithRelations | null> {
    return this.prisma.claim.findUnique({
      where: { id },
      include: CLAIM_RELATIONS,
    });
  }

  findByUserAndCampaign(userId: string, campaignId: string): Promise<Claim | null> {
    return this.prisma.claim.findUnique({
      where: { campaignId_userId: { campaignId, userId } },
    });
  }

  listByUser(
    userId: string,
    params: { skip: number; take: number; status?: ClaimStatus },
  ): Promise<[ClaimWithRelations[], number]> {
    const where: Prisma.ClaimWhereInput = {
      userId,
      ...(params.status ? { status: params.status } : {}),
    };
    return Promise.all([
      this.prisma.claim.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: "desc" },
        include: CLAIM_RELATIONS,
      }),
      this.prisma.claim.count({ where }),
    ]);
  }

  list(params: {
    skip: number;
    take: number;
    status?: ClaimStatus;
  }): Promise<[ClaimWithRelations[], number]> {
    const where: Prisma.ClaimWhereInput = params.status ? { status: params.status } : {};
    return Promise.all([
      this.prisma.claim.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: "desc" },
        include: CLAIM_RELATIONS,
      }),
      this.prisma.claim.count({ where }),
    ]);
  }

  countByStatus(status: ClaimStatus): Promise<number> {
    return this.prisma.claim.count({ where: { status } });
  }
}
