import { z } from "zod";
import type {
  FeedbackPage,
  Offer,
  OfferCategory,
  Prisma,
} from "@prisma/client";

const contentStatusSchema = z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]);
export type ContentStatusValue = z.infer<typeof contentStatusSchema>;

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase words separated by dashes")
  .min(2)
  .max(80);

/** Fallback slug when the admin leaves it blank. */
export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const categorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  imageUrl: z.string().nullable(),
  priority: z.number().int(),
  featured: z.boolean(),
  status: contentStatusSchema,
  hasFeedbackPage: z.boolean(),
  offerCount: z.number().int(),
  createdAt: z.string().datetime(),
});
export type CategoryDto = z.infer<typeof categorySchema>;

export type CategoryWithCounts = OfferCategory & {
  feedbackPage: { id: string } | null;
  _count: { offers: number };
};

export const toCategoryDto = (category: CategoryWithCounts): CategoryDto => ({
  id: category.id,
  slug: category.slug,
  title: category.title,
  subtitle: category.subtitle,
  imageUrl: category.imageUrl,
  priority: category.priority,
  featured: category.featured,
  status: category.status,
  hasFeedbackPage: category.feedbackPage !== null,
  offerCount: category._count.offers,
  createdAt: category.createdAt.toISOString(),
});

export const upsertCategorySchema = z.object({
  slug: slugSchema.optional(),
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional().nullable(),
  imageUrl: z.string().url().max(2048).optional().nullable(),
  priority: z.number().int().min(0).max(10_000).default(0),
  featured: z.boolean().default(false),
  status: contentStatusSchema.default("DRAFT"),
});
export type UpsertCategoryInput = z.infer<typeof upsertCategorySchema>;

// ---------------------------------------------------------------------------
// Feedback pages
// ---------------------------------------------------------------------------

export const feedbackPageSchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid(),
  categorySlug: z.string(),
  categoryTitle: z.string(),
  categoryImageUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  benefits: z.array(z.string()),
  rewardPoints: z.number().int(),
  buttonText: z.string(),
  buttonVisible: z.boolean(),
  websiteUrl: z.string(),
  status: contentStatusSchema,
});
export type FeedbackPageDto = z.infer<typeof feedbackPageSchema>;

export const toFeedbackPageDto = (
  page: FeedbackPage & { category: { slug: string; title: string; imageUrl: string | null } },
): FeedbackPageDto => ({
  id: page.id,
  categoryId: page.categoryId,
  categorySlug: page.category.slug,
  categoryTitle: page.category.title,
  categoryImageUrl: page.category.imageUrl,
  bannerUrl: page.bannerUrl,
  title: page.title,
  description: page.description,
  benefits: (page.benefits as string[] | null) ?? [],
  rewardPoints: page.rewardPoints,
  buttonText: page.buttonText,
  buttonVisible: page.buttonVisible,
  websiteUrl: page.websiteUrl,
  status: page.status,
});

export const upsertFeedbackPageSchema = z.object({
  bannerUrl: z.string().url().max(2048).optional().nullable(),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(5000),
  benefits: z.array(z.string().min(1).max(200)).max(20).default([]),
  rewardPoints: z.number().int().min(0).default(0),
  buttonText: z.string().min(1).max(40).default("Download"),
  buttonVisible: z.boolean().default(true),
  websiteUrl: z.string().url().max(2048),
  status: contentStatusSchema.default("DRAFT"),
});
export type UpsertFeedbackPageInput = z.infer<typeof upsertFeedbackPageSchema>;

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

const difficultySchema = z.enum(["EASY", "MEDIUM", "HARD"]);

/** What a user who completed the offer (APPROVED submission) sees. */
const completedBehaviorSchema = z.enum(["SHOW", "HIDE", "SHOW_COMPLETED"]);

export const offerCardSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  appName: z.string().nullable(),
  logoUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  shortDescription: z.string(),
  rewardAmount: z.number(),
  rewardCoins: z.number().int(),
  rewardLabel: z.string().nullable(),
  difficulty: difficultySchema,
  estimatedTime: z.string().nullable(),
  rating: z.number().nullable(),
  isProduct: z.boolean(),
  brandLogoUrl: z.string().nullable(),
  featured: z.boolean(),
  trending: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
  priority: z.number().int(),
  status: contentStatusSchema,
  completedBehavior: completedBehaviorSchema,
  /** True when the requesting user's submission for this offer is APPROVED. */
  completed: z.boolean(),
  category: z.object({ id: z.string().uuid(), slug: z.string(), title: z.string() }),
  createdAt: z.string().datetime(),
});
export type OfferCardDto = z.infer<typeof offerCardSchema>;

export const offerDetailsSchema = offerCardSchema.extend({
  bannerUrl: z.string().nullable(),
  description: z.string(),
  taskDescription: z.string().nullable(),
  features: z.array(z.string()),
  instructions: z.array(z.string()),
  requirements: z.array(z.string()),
  terms: z.string().nullable(),
  warning: z.string().nullable(),
  playStoreUrl: z.string(),
  maxUsers: z.number().int().nullable(),
  maxRewards: z.number().int().nullable(),
  dailyLimit: z.number().int().nullable(),
});
export type OfferDetailsDto = z.infer<typeof offerDetailsSchema>;

export type OfferWithCategory = Offer & {
  category: { id: string; slug: string; title: string };
};

export const toOfferCardDto = (offer: OfferWithCategory, completed = false): OfferCardDto => ({
  id: offer.id,
  slug: offer.slug,
  title: offer.title,
  appName: offer.appName,
  logoUrl: offer.logoUrl,
  thumbnailUrl: offer.thumbnailUrl,
  shortDescription: offer.shortDescription,
  rewardAmount: Number(offer.rewardAmount),
  rewardCoins: offer.rewardCoins,
  rewardLabel: offer.rewardLabel,
  difficulty: offer.difficulty,
  estimatedTime: offer.estimatedTime,
  rating: offer.rating === null ? null : Number(offer.rating),
  isProduct: offer.isProduct,
  brandLogoUrl: offer.brandLogoUrl,
  featured: offer.featured,
  trending: offer.trending,
  expiresAt: offer.expiresAt?.toISOString() ?? null,
  priority: offer.priority,
  status: offer.status,
  completedBehavior: offer.completedBehavior,
  completed,
  category: {
    id: offer.category.id,
    slug: offer.category.slug,
    title: offer.category.title,
  },
  createdAt: offer.createdAt.toISOString(),
});

export const toOfferDetailsDto = (
  offer: OfferWithCategory,
  completed = false,
): OfferDetailsDto => ({
  ...toOfferCardDto(offer, completed),
  bannerUrl: offer.bannerUrl,
  description: offer.description,
  taskDescription: offer.taskDescription,
  features: (offer.features as string[] | null) ?? [],
  instructions: (offer.instructions as string[] | null) ?? [],
  requirements: (offer.requirements as string[] | null) ?? [],
  terms: offer.terms,
  warning: offer.warning,
  playStoreUrl: offer.playStoreUrl,
  maxUsers: offer.maxUsers,
  maxRewards: offer.maxRewards,
  dailyLimit: offer.dailyLimit,
});

export const listOffersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
  category: slugSchema.optional(),
  search: z.string().max(120).optional(),
  sort: z.enum(["priority", "newest", "reward"]).default("priority"),
  // Querystring booleans arrive as strings; omitted = unfiltered.
  product: z.enum(["true", "false"]).optional(),
});
export type ListOffersQuery = z.infer<typeof listOffersQuerySchema>;

export const adminListOffersQuerySchema = listOffersQuerySchema.extend({
  status: contentStatusSchema.optional(),
});
export type AdminListOffersQuery = z.infer<typeof adminListOffersQuerySchema>;

export const upsertOfferSchema = z.object({
  categoryId: z.string().uuid(),
  slug: slugSchema.optional(),
  title: z.string().min(1).max(140),
  appName: z.string().max(120).optional().nullable(),
  logoUrl: z.string().url().max(2048).optional().nullable(),
  thumbnailUrl: z.string().url().max(2048).optional().nullable(),
  bannerUrl: z.string().url().max(2048).optional().nullable(),
  shortDescription: z.string().min(1).max(200),
  description: z.string().min(1).max(10_000),
  features: z.array(z.string().min(1).max(200)).max(20).default([]),
  instructions: z.array(z.string().min(1).max(300)).max(20).default([]),
  requirements: z.array(z.string().min(1).max(200)).max(20).default([]),
  terms: z.string().max(5000).optional().nullable(),
  warning: z.string().max(1000).optional().nullable(),
  rewardAmount: z.number().min(0).max(1_000_000),
  rewardCoins: z.number().int().min(0).max(10_000_000).default(0),
  rewardLabel: z.string().max(80).optional().nullable(),
  taskDescription: z.string().max(2000).optional().nullable(),
  difficulty: difficultySchema.default("EASY"),
  estimatedTime: z.string().max(40).optional().nullable(),
  rating: z.number().min(0).max(5).optional().nullable(),
  playStoreUrl: z
    .string()
    .url()
    .startsWith("https://play.google.com/", "Must be a Play Store URL")
    .max(2048),
  isProduct: z.boolean().default(false),
  brandLogoUrl: z.string().url().max(2048).optional().nullable(),
  featured: z.boolean().default(false),
  trending: z.boolean().default(false),
  expiresAt: z.string().datetime().optional().nullable(),
  maxUsers: z.number().int().min(1).optional().nullable(),
  maxRewards: z.number().int().min(1).optional().nullable(),
  dailyLimit: z.number().int().min(1).optional().nullable(),
  completedBehavior: completedBehaviorSchema.default("SHOW"),
  priority: z.number().int().min(0).max(10_000).default(0),
  status: contentStatusSchema.default("DRAFT"),
});
export type UpsertOfferInput = z.infer<typeof upsertOfferSchema>;

// ---------------------------------------------------------------------------
// Events & analytics
// ---------------------------------------------------------------------------

export const trackEventSchema = z
  .object({
    type: z.enum(["VIEW", "CLICK", "DOWNLOAD"]),
    source: z.enum(["APP", "WEBSITE"]),
    sessionId: z.string().min(8).max(100),
    offerId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
  })
  .refine((input) => Boolean(input.offerId) || Boolean(input.categoryId), {
    message: "offerId or categoryId is required",
    path: ["offerId"],
  });
export type TrackEventInput = z.infer<typeof trackEventSchema>;

export const analyticsQuerySchema = z.object({
  range: z.enum(["daily", "weekly", "monthly"]).default("daily"),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export interface OfferAnalyticsDto {
  totals: {
    views: number;
    clicks: number;
    downloads: number;
    uniqueUsers: number;
    /** clicks / views, 0..1 */
    ctr: number;
    /** downloads / views, 0..1 */
    conversionRate: number;
  };
  topOffers: { id: string; slug: string; title: string; views: number; clicks: number; downloads: number }[];
  topCategories: { id: string; slug: string; title: string; views: number; clicks: number; downloads: number }[];
  series: { bucket: string; views: number; clicks: number; downloads: number }[];
}

export const idParamsSchema = z.object({ id: z.string().uuid() });
export type IdParams = z.infer<typeof idParamsSchema>;

export const slugParamsSchema = z.object({ slug: slugSchema });
export type SlugParams = z.infer<typeof slugParamsSchema>;

/** Prisma JSON helper: undefined leaves the column untouched on update. */
export const asJson = (value: string[] | undefined): Prisma.InputJsonValue | undefined =>
  value === undefined ? undefined : value;
