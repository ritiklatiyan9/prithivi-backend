import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../../common/errors.js";
import { ASSET_SLOTS, SLOTS_BY_KEY } from "../registry.js";

export interface PublicSlotDto {
  key: string;
  page: string;
  imageUrl: string | null; // override URL, or null = use bundled default
  updatedAt: string | null;
}

export interface AdminSlotDto extends PublicSlotDto {
  label: string;
  description: string;
  updatedBy: string | null; // email of the admin who set the override
}

/**
 * In-app graphic overrides. Registry (slots) lives in code; the DB stores
 * one row per overridden slot. Simple enough that no repository layer exists.
 */
export class AppAssetsService {
  private publicCache: { value: { slots: PublicSlotDto[] }; expiresAt: number } | null = null;
  private publicLoad: { generation: number; promise: Promise<{ slots: PublicSlotDto[] }> } | null =
    null;
  private publicGeneration = 0;
  private static readonly PUBLIC_TTL_MS = 60_000;

  constructor(private readonly prisma: PrismaClient) {}

  private assertSlot(key: string): void {
    if (!SLOTS_BY_KEY[key]) throw new NotFoundError(`Unknown asset slot "${key}"`);
  }

  async listPublic(): Promise<{ slots: PublicSlotDto[] }> {
    if (this.publicCache && this.publicCache.expiresAt > Date.now()) {
      return this.publicCache.value;
    }
    const generation = this.publicGeneration;
    if (this.publicLoad?.generation === generation) return this.publicLoad.promise;

    const promise = this.prisma.appAsset.findMany().then((rows) => {
      const byKey = new Map(rows.map((row) => [row.slotKey, row]));
      return {
        slots: ASSET_SLOTS.map((slot) => {
          const override = byKey.get(slot.key);
          return {
            key: slot.key,
            page: slot.page,
            imageUrl: override?.imageUrl ?? null,
            updatedAt: override?.updatedAt.toISOString() ?? null,
          };
        }),
      };
    });
    this.publicLoad = { generation, promise };
    try {
      const value = await promise;
      if (generation === this.publicGeneration) {
        this.publicCache = { value, expiresAt: Date.now() + AppAssetsService.PUBLIC_TTL_MS };
      }
      return value;
    } finally {
      if (this.publicLoad?.promise === promise) this.publicLoad = null;
    }
  }

  async listAdmin(): Promise<{ slots: AdminSlotDto[] }> {
    const rows = await this.prisma.appAsset.findMany();
    const byKey = new Map(rows.map((row) => [row.slotKey, row]));

    const updaterIds = [
      ...new Set(rows.map((row) => row.updatedById).filter((id): id is string => !!id)),
    ];
    const updaters = updaterIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: updaterIds } },
          select: { id: true, email: true },
        })
      : [];
    const emailById = new Map(updaters.map((user) => [user.id, user.email]));

    return {
      slots: ASSET_SLOTS.map((slot) => {
        const override = byKey.get(slot.key);
        return {
          key: slot.key,
          page: slot.page,
          label: slot.label,
          description: slot.description,
          imageUrl: override?.imageUrl ?? null,
          updatedAt: override?.updatedAt.toISOString() ?? null,
          updatedBy: (override?.updatedById && emailById.get(override.updatedById)) || null,
        };
      }),
    };
  }

  async upsert(key: string, imageUrl: string, updatedById: string | undefined) {
    this.assertSlot(key);
    const row = await this.prisma.appAsset.upsert({
      where: { slotKey: key },
      create: { slotKey: key, imageUrl, updatedById },
      update: { imageUrl, updatedById },
    });
    this.invalidatePublicCache();
    return { key, imageUrl: row.imageUrl, updatedAt: row.updatedAt.toISOString() };
  }

  /** Idempotent: deleting a slot with no override is a no-op. */
  async remove(key: string): Promise<null> {
    this.assertSlot(key);
    await this.prisma.appAsset.deleteMany({ where: { slotKey: key } });
    this.invalidatePublicCache();
    return null;
  }

  private invalidatePublicCache(): void {
    this.publicGeneration += 1;
    this.publicCache = null;
  }
}
