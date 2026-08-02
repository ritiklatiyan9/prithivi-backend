import { Prisma } from "@prisma/client";
import type {
  FeedbackPage,
  Offer,
  OfferCategory,
  OfferSubmission,
  PrismaClient,
  SubmissionStatus,
} from "@prisma/client";
import type {
  AdminListOffersQuery,
  CategoryWithCounts,
  ListOffersQuery,
  OfferWithCategory,
} from "../schemas/hot-offers.schema.js";
import type {
  ListSubmissionsQuery,
  SubmissionWithRelations,
} from "../schemas/submissions.schema.js";
import { ConflictError } from "../../../common/errors.js";

const SUBMISSION_OFFER_SELECT = {
  offer: { select: { title: true, slug: true, thumbnailUrl: true } },
  // Every proof image newest-first, so a resubmit's images lead the array.
  images: { select: { url: true }, orderBy: { createdAt: "desc" as const } },
} as const;

const CATEGORY_INCLUDE = {
  feedbackPage: { select: { id: true } },
  _count: { select: { offers: true } },
} as const;

const OFFER_INCLUDE = {
  category: { select: { id: true, slug: true, title: true } },
} as const;

const offerOrderBy = (sort: ListOffersQuery["sort"]): Prisma.OfferOrderByWithRelationInput[] => {
  switch (sort) {
    case "newest":
      return [{ createdAt: "desc" }];
    case "reward":
      return [{ rewardAmount: "desc" }, { priority: "desc" }];
    default:
      return [{ featured: "desc" }, { priority: "desc" }, { createdAt: "desc" }];
  }
};

export class HotOffersRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- categories ----

  listCategories(params: { publishedOnly: boolean }): Promise<CategoryWithCounts[]> {
    return this.prisma.offerCategory.findMany({
      where: {
        deletedAt: null,
        ...(params.publishedOnly ? { status: "PUBLISHED" } : {}),
      },
      include: CATEGORY_INCLUDE,
      orderBy: [{ featured: "desc" }, { priority: "desc" }, { createdAt: "asc" }],
    });
  }

  findCategoryById(id: string): Promise<OfferCategory | null> {
    return this.prisma.offerCategory.findFirst({ where: { id, deletedAt: null } });
  }

  findCategoryBySlug(slug: string): Promise<OfferCategory | null> {
    return this.prisma.offerCategory.findFirst({ where: { slug, deletedAt: null } });
  }

  /** True if ANY row (incl. soft-deleted) holds this slug — the DB @unique
   *  spans deleted rows, so the check must too. */
  async categorySlugExists(slug: string, exceptId?: string): Promise<boolean> {
    const found = await this.prisma.offerCategory.findFirst({
      where: { slug, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  }

  createCategory(data: Prisma.OfferCategoryUncheckedCreateInput): Promise<CategoryWithCounts> {
    return this.prisma.offerCategory.create({ data, include: CATEGORY_INCLUDE });
  }

  updateCategory(
    id: string,
    data: Prisma.OfferCategoryUncheckedUpdateInput,
  ): Promise<CategoryWithCounts> {
    return this.prisma.offerCategory.update({ where: { id }, data, include: CATEGORY_INCLUDE });
  }

  async softDeleteCategory(id: string, freedSlug: string): Promise<void> {
    // Mangle the slug so the human-readable one is released for reuse.
    await this.prisma.offerCategory.update({
      where: { id },
      data: { deletedAt: new Date(), slug: freedSlug },
    });
  }

  // ---- feedback pages ----

  findFeedbackPageByCategorySlug(
    slug: string,
    publishedOnly: boolean,
  ): Promise<
    (FeedbackPage & { category: { slug: string; title: string; imageUrl: string | null } }) | null
  > {
    return this.prisma.feedbackPage.findFirst({
      where: {
        deletedAt: null,
        ...(publishedOnly ? { status: "PUBLISHED" } : {}),
        category: { slug, deletedAt: null },
      },
      include: { category: { select: { slug: true, title: true, imageUrl: true } } },
    });
  }

  upsertFeedbackPage(
    categoryId: string,
    data: Omit<Prisma.FeedbackPageUncheckedCreateInput, "categoryId">,
  ): Promise<
    FeedbackPage & { category: { slug: string; title: string; imageUrl: string | null } }
  > {
    return this.prisma.feedbackPage.upsert({
      where: { categoryId },
      create: { categoryId, ...data },
      update: data,
      include: { category: { select: { slug: true, title: true, imageUrl: true } } },
    });
  }

  // ---- offers ----

  async listOffers(
    query: AdminListOffersQuery,
    params: { publishedOnly: boolean },
  ): Promise<[OfferWithCategory[], number]> {
    const where: Prisma.OfferWhereInput = {
      deletedAt: null,
      ...(params.publishedOnly
        ? {
            status: "PUBLISHED",
            // Expired offers stay visible to admins but leave public lists.
            // Nested in AND so it can't collide with the search OR below.
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
          }
        : {}),
      ...(query.status && !params.publishedOnly ? { status: query.status } : {}),
      ...(query.category ? { category: { slug: query.category, deletedAt: null } } : {}),
      ...(query.product !== undefined ? { isProduct: query.product === "true" } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: "insensitive" } },
              { appName: { contains: query.search, mode: "insensitive" } },
              { shortDescription: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    return Promise.all([
      this.prisma.offer.findMany({
        where,
        include: OFFER_INCLUDE,
        orderBy: offerOrderBy(query.sort),
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.offer.count({ where }),
    ]);
  }

  findOfferById(id: string): Promise<OfferWithCategory | null> {
    return this.prisma.offer.findFirst({
      where: { id, deletedAt: null },
      include: OFFER_INCLUDE,
    });
  }

  findOfferBySlug(slug: string, publishedOnly: boolean): Promise<OfferWithCategory | null> {
    return this.prisma.offer.findFirst({
      where: {
        slug,
        deletedAt: null,
        ...(publishedOnly ? { status: "PUBLISHED" } : {}),
      },
      include: OFFER_INCLUDE,
    });
  }

  /** True if ANY row (incl. soft-deleted) holds this slug — matches @unique. */
  async offerSlugExists(slug: string, exceptId?: string): Promise<boolean> {
    const found = await this.prisma.offer.findFirst({
      where: { slug, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    return found !== null;
  }

  createOffer(data: Prisma.OfferUncheckedCreateInput): Promise<OfferWithCategory> {
    return this.prisma.offer.create({ data, include: OFFER_INCLUDE });
  }

  updateOffer(id: string, data: Prisma.OfferUncheckedUpdateInput): Promise<OfferWithCategory> {
    return this.prisma.offer.update({ where: { id }, data, include: OFFER_INCLUDE });
  }

  async softDeleteOffer(id: string, freedSlug: string): Promise<void> {
    await this.prisma.offer.update({
      where: { id },
      data: { deletedAt: new Date(), slug: freedSlug },
    });
  }

  // ---- events & analytics ----

  async createEvent(data: Prisma.OfferEventUncheckedCreateInput): Promise<void> {
    await this.prisma.offerEvent.create({ data });
  }

  async countEventsByType(since: Date): Promise<Record<string, number>> {
    const rows = await this.prisma.offerEvent.groupBy({
      by: ["type"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((row) => [row.type, row._count._all]));
  }

  async countUniqueSessions(since: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT "sessionId") AS count
      FROM offer_events
      WHERE "createdAt" >= ${since}
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /** Per-offer view/click/download counts, top N by downloads then views. */
  async topOffers(since: Date, limit: number) {
    return this.prisma.$queryRaw<
      {
        id: string;
        slug: string;
        title: string;
        views: bigint;
        clicks: bigint;
        downloads: bigint;
      }[]
    >`
      SELECT o.id, o.slug, o.title,
             COUNT(*) FILTER (WHERE e.type = 'VIEW')     AS views,
             COUNT(*) FILTER (WHERE e.type = 'CLICK')    AS clicks,
             COUNT(*) FILTER (WHERE e.type = 'DOWNLOAD') AS downloads
      FROM offer_events e
      JOIN offers o ON o.id = e."offerId"
      WHERE e."createdAt" >= ${since} AND e."offerId" IS NOT NULL
      GROUP BY o.id, o.slug, o.title
      ORDER BY downloads DESC, views DESC
      LIMIT ${limit}
    `;
  }

  async topCategories(since: Date, limit: number) {
    return this.prisma.$queryRaw<
      {
        id: string;
        slug: string;
        title: string;
        views: bigint;
        clicks: bigint;
        downloads: bigint;
      }[]
    >`
      SELECT c.id, c.slug, c.title,
             COUNT(*) FILTER (WHERE e.type = 'VIEW')     AS views,
             COUNT(*) FILTER (WHERE e.type = 'CLICK')    AS clicks,
             COUNT(*) FILTER (WHERE e.type = 'DOWNLOAD') AS downloads
      FROM offer_events e
      JOIN offer_categories c
        ON c.id = COALESCE(e."categoryId", (SELECT "categoryId" FROM offers WHERE id = e."offerId"))
      WHERE e."createdAt" >= ${since}
      GROUP BY c.id, c.slug, c.title
      ORDER BY downloads DESC, views DESC
      LIMIT ${limit}
    `;
  }

  /** Time-bucketed event counts (bucket = day/week/month start). */
  async eventSeries(since: Date, bucket: "day" | "week" | "month") {
    // date_trunc's unit cannot be parameterized; the value is restricted to a
    // literal union above, so interpolation here is safe.
    return this.prisma.$queryRawUnsafe<
      { bucket: Date; views: bigint; clicks: bigint; downloads: bigint }[]
    >(
      `SELECT date_trunc('${bucket}', "createdAt") AS bucket,
              COUNT(*) FILTER (WHERE type = 'VIEW')     AS views,
              COUNT(*) FILTER (WHERE type = 'CLICK')    AS clicks,
              COUNT(*) FILTER (WHERE type = 'DOWNLOAD') AS downloads
       FROM offer_events
       WHERE "createdAt" >= $1
       GROUP BY 1
       ORDER BY 1`,
      since,
    );
  }

  // ---- proof submissions ----

  findSubmission(offerId: string, userId: string): Promise<OfferSubmission | null> {
    return this.prisma.offerSubmission.findUnique({
      where: { offerId_userId: { offerId, userId } },
    });
  }

  findSubmissionWithOffer(
    offerId: string,
    userId: string,
  ): Promise<SubmissionWithRelations | null> {
    return this.prisma.offerSubmission.findUnique({
      where: { offerId_userId: { offerId, userId } },
      include: SUBMISSION_OFFER_SELECT,
    });
  }

  findSubmissionById(id: string): Promise<OfferSubmission | null> {
    return this.prisma.offerSubmission.findUnique({ where: { id } });
  }

  createSubmission(
    data: Prisma.OfferSubmissionUncheckedCreateInput,
  ): Promise<SubmissionWithRelations> {
    return this.prisma.offerSubmission.create({ data, include: SUBMISSION_OFFER_SELECT });
  }

  /** Reset a REJECTED submission to PENDING with a fresh screenshot/note. */
  resubmit(
    id: string,
    data: { screenshotUrl: string; note: string | null; rewardAmount: Prisma.Decimal | number },
  ): Promise<SubmissionWithRelations> {
    return this.prisma.offerSubmission.update({
      where: { id },
      data: {
        screenshotUrl: data.screenshotUrl,
        note: data.note,
        rewardAmount: data.rewardAmount,
        status: "PENDING",
        reviewNote: null,
        reviewedById: null,
        reviewedAt: null,
      },
      include: SUBMISSION_OFFER_SELECT,
    });
  }

  listSubmissionsByUser(
    userId: string,
    params: { skip: number; take: number },
  ): Promise<[SubmissionWithRelations[], number]> {
    const where = { userId } satisfies Prisma.OfferSubmissionWhereInput;
    return Promise.all([
      this.prisma.offerSubmission.findMany({
        where,
        include: SUBMISSION_OFFER_SELECT,
        orderBy: { createdAt: "desc" },
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.offerSubmission.count({ where }),
    ]);
  }

  listSubmissionsAdmin(params: {
    skip: number;
    take: number;
    status?: SubmissionStatus;
    isProduct?: boolean;
  }): Promise<[SubmissionWithRelations[], number]> {
    const where: Prisma.OfferSubmissionWhereInput = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.isProduct !== undefined ? { offer: { isProduct: params.isProduct } } : {}),
    };
    return Promise.all([
      this.prisma.offerSubmission.findMany({
        where,
        include: {
          ...SUBMISSION_OFFER_SELECT,
          user: { select: { id: true, name: true, email: true } },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip: params.skip,
        take: params.take,
      }),
      this.prisma.offerSubmission.count({ where }),
    ]);
  }

  /**
   * Approve a submission and credit the offer's reward to the user's wallet —
   * both must commit together, mirroring the campaign-claim approval flow.
   */
  async approveSubmission(id: string, reviewerId: string): Promise<SubmissionWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const marked = await tx.offerSubmission.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "APPROVED", reviewedById: reviewerId, reviewedAt: new Date() },
      });
      if (marked.count === 0) {
        throw new ConflictError("Submission has already been reviewed");
      }
      const submission = await tx.offerSubmission.findUniqueOrThrow({
        where: { id },
        include: SUBMISSION_OFFER_SELECT,
      });

      const wallet = await tx.wallet.upsert({
        where: { userId: submission.userId },
        create: { userId: submission.userId },
        update: {},
      });
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: submission.rewardAmount } },
      });
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: "CREDIT",
          amount: new Prisma.Decimal(submission.rewardAmount),
          balanceAfter: updated.balance,
          reference: `offer-submission:${submission.id}`,
          description: `Reward for offer "${submission.offer.title}"`,
        },
      });

      return submission;
    });
  }

  /** Non-crediting review outcome (REJECTED or NEED_MORE_PROOF). */
  async setReviewOutcome(
    id: string,
    status: "REJECTED" | "NEED_MORE_PROOF",
    reviewerId: string,
    reviewNote: string | null,
  ): Promise<SubmissionWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const marked = await tx.offerSubmission.updateMany({
        where: { id, status: "PENDING" },
        data: { status, reviewNote, reviewedById: reviewerId, reviewedAt: new Date() },
      });
      if (marked.count === 0) {
        throw new ConflictError("Submission has already been reviewed");
      }
      return tx.offerSubmission.findUniqueOrThrow({
        where: { id },
        include: SUBMISSION_OFFER_SELECT,
      });
    });
  }

  /** User cancels their own pending submission. */
  async cancelSubmission(id: string): Promise<SubmissionWithRelations> {
    return this.prisma.$transaction(async (tx) => {
      const marked = await tx.offerSubmission.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "CANCELLED" },
      });
      if (marked.count === 0) {
        throw new ConflictError("Submission can no longer be cancelled");
      }
      return tx.offerSubmission.findUniqueOrThrow({
        where: { id },
        include: SUBMISSION_OFFER_SELECT,
      });
    });
  }

  /**
   * Admin re-opens a finished submission so the user may participate in the
   * offer again: CANCELLED passes the submit gate, and the next submission
   * reuses this row (unique [offerId,userId]). Guarded so a racing review
   * loses cleanly.
   */
  async reopenSubmission(id: string, reviewerId: string): Promise<SubmissionWithRelations | null> {
    const marked = await this.prisma.offerSubmission.updateMany({
      where: { id, status: { in: ["APPROVED", "REJECTED", "NEED_MORE_PROOF"] } },
      data: { status: "CANCELLED", reviewedById: reviewerId, reviewedAt: new Date() },
    });
    if (marked.count === 0) return null;
    return this.prisma.offerSubmission.findUnique({
      where: { id },
      include: SUBMISSION_OFFER_SELECT,
    });
  }

  // ---- fraud & duplicate protection (Module 4) ----

  async createSubmissionImages(
    submissionId: string,
    images: { url: string; hash: string; byteSize: number }[],
  ): Promise<void> {
    await this.prisma.submissionImage.createMany({
      data: images.map((image) => ({ submissionId, ...image })),
    });
  }

  /** An image with this hash on someone else's active (PENDING/APPROVED)
   *  submission — i.e. a reused screenshot. Excludes [exceptSubmissionId]
   *  (the caller's own row, so a legit resubmit isn't flagged). */
  async findDuplicateImage(
    hash: string,
    exceptSubmissionId: string | null,
  ): Promise<{ submissionId: string } | null> {
    const image = await this.prisma.submissionImage.findFirst({
      where: {
        hash,
        ...(exceptSubmissionId ? { NOT: { submissionId: exceptSubmissionId } } : {}),
        submission: { status: { in: ["PENDING", "APPROVED"] } },
      },
      select: { submissionId: true },
    });
    return image;
  }

  /** Distinct users with a non-cancelled submission for an offer (maxUsers). */
  countDistinctParticipants(offerId: string): Promise<number> {
    // [offerId,userId] is unique, so COUNT is already a distinct participant
    // count. Let PostgreSQL return one scalar instead of materializing every
    // participant id in Node.js.
    return this.prisma.offerSubmission.count({
      where: { offerId, status: { not: "CANCELLED" } },
    });
  }

  /** Approved submissions for an offer (maxRewards). */
  countApproved(offerId: string): Promise<number> {
    return this.prisma.offerSubmission.count({ where: { offerId, status: "APPROVED" } });
  }

  /** This user's image-upload attempts for an offer since [since] (dailyLimit). */
  countImagesForUserOfferSince(userId: string, offerId: string, since: Date): Promise<number> {
    return this.prisma.submissionImage.count({
      where: { createdAt: { gte: since }, submission: { userId, offerId } },
    });
  }

  countPendingByUser(userId: string): Promise<number> {
    return this.prisma.offerSubmission.count({ where: { userId, status: "PENDING" } });
  }

  async createFraudLog(data: {
    userId: string;
    submissionId?: string | null;
    type: "DUPLICATE_IMAGE" | "DAILY_LIMIT" | "EXCESS_PENDING" | "MANUAL";
    score: number;
    detail?: string | null;
  }): Promise<void> {
    await this.prisma.fraudLog.create({ data });
  }

  listFraudLogs(params: { skip: number; take: number }) {
    return Promise.all([
      this.prisma.fraudLog.findMany({
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: "desc" },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.fraudLog.count(),
    ]);
  }

  /** Per-user fraud score totals (highest first) with the user's details. */
  async userFraudScores(limit: number) {
    const grouped = await this.prisma.fraudLog.groupBy({
      by: ["userId"],
      _sum: { score: true },
      _count: { _all: true },
      orderBy: { _sum: { score: "desc" } },
      take: limit,
    });
    if (grouped.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.userId) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return grouped.map((g) => ({
      user: byId.get(g.userId) ?? { id: g.userId, name: "Unknown", email: "" },
      score: g._sum.score ?? 0,
      events: g._count._all,
    }));
  }
}
