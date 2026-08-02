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
