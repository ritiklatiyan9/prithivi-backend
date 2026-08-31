import { describe, expect, it, vi } from "vitest";
import type { HotOffersRepository } from "../repositories/hot-offers.repository.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import { HotOffersService } from "./hot-offers.service.js";

const category = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "games",
  title: "Games",
  subtitle: null,
  imageUrl: null,
  priority: 1,
  featured: true,
  status: "PUBLISHED" as const,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
  feedbackPage: null,
  _count: { offers: 2 },
};

const offer = {
  id: "00000000-0000-4000-8000-000000000010",
  categoryId: category.id,
  slug: "coin-quest",
  title: "Coin Quest",
  appName: null,
  logoUrl: null,
  thumbnailUrl: null,
  bannerUrl: null,
  shortDescription: "Play and earn",
  description: "Play and earn coins",
  features: null,
  instructions: null,
  requirements: null,
  terms: null,
  warning: null,
  rewardAmount: 50,
  rewardCoins: 0,
  rewardLabel: null,
  taskDescription: null,
  difficulty: "EASY" as const,
  estimatedTime: null,
  rating: null,
  playStoreUrl: "https://play.google.com/store/apps/details?id=x",
  isProduct: false,
  brandLogoUrl: null,
  featured: false,
  trending: false,
  expiresAt: null,
  maxUsers: null,
  maxRewards: null,
  dailyLimit: null,
  completedBehavior: "SHOW_COMPLETED" as const,
  priority: 0,
  status: "PUBLISHED" as const,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
  category: { id: category.id, slug: category.slug, title: category.title },
};

describe("completed-offer personalization", () => {
  const query = { page: 1, limit: 12, sort: "priority" as const };

  it("anonymous requests skip the completion lookup and never set completed", async () => {
    const approvedOfferIds = vi.fn();
    const repo = {
      listOffers: vi.fn(async () => [[offer], 1]),
      approvedOfferIds,
    } as unknown as HotOffersRepository;
    const service = new HotOffersService(repo, {} as NotificationsService, {} as SettingsService);

    const { items } = await service.listPublicOffers(query);
    expect(items[0]?.completed).toBe(false);
    expect(approvedOfferIds).not.toHaveBeenCalled();
  });

  it("signed-in requests pass completed ids to the repo filter and flag completed cards", async () => {
    const listOffers = vi.fn(async () => [[offer], 1]);
    const repo = {
      listOffers,
      approvedOfferIds: vi.fn(async () => new Set([offer.id])),
    } as unknown as HotOffersRepository;
    const service = new HotOffersService(repo, {} as NotificationsService, {} as SettingsService);

    const { items } = await service.listPublicOffers(query, "user-1");
    expect(items[0]?.completed).toBe(true);
    expect(items[0]?.completedBehavior).toBe("SHOW_COMPLETED");
    expect(listOffers).toHaveBeenCalledWith(query, {
      publishedOnly: true,
      hideCompletedFor: new Set([offer.id]),
    });
  });
});

describe("public catalog cache", () => {
  it("coalesces concurrent reads and invalidates immediately after a CMS mutation", async () => {
    const listCategories = vi.fn(async () => [category]);
    const repo = {
      listCategories,
      categorySlugExists: vi.fn(async () => false),
      createCategory: vi.fn(async () => ({ ...category, slug: "new-games" })),
    } as unknown as HotOffersRepository;
    const service = new HotOffersService(repo, {} as NotificationsService, {} as SettingsService);

    const [first, second] = await Promise.all([
      service.listPublicCategories(),
      service.listPublicCategories(),
    ]);
    expect(first).toEqual(second);
    expect(listCategories).toHaveBeenCalledTimes(1);

    await service.createCategory({
      slug: "new-games",
      title: "New Games",
      subtitle: null,
      imageUrl: null,
      priority: 1,
      featured: true,
      status: "PUBLISHED",
    });
    await service.listPublicCategories();

    expect(listCategories).toHaveBeenCalledTimes(2);
  });
});
