import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { HotOffersRepository } from "./hot-offers.repository.js";

describe("mobile offer queries", () => {
  it("filters completion in SQL and reads only the current page's card/proof fields", async () => {
    const findMany = vi.fn(async (_args: unknown) => [
      { id: "offer", submissions: [{ id: "proof" }] },
    ]);
    const count = vi.fn(async () => 1);
    const repo = new HotOffersRepository({ offer: { findMany, count } } as unknown as PrismaClient);
    const [cards, total] = await repo.listOfferCards(
      { page: 2, limit: 10, sort: "priority" },
      "alice",
    );
    const args = findMany.mock.calls[0]![0] as unknown as Record<string, any>;
    expect(args.where.NOT).toEqual({
      completedBehavior: "HIDE",
      submissions: { some: { userId: "alice", status: "APPROVED" } },
    });
    expect(args.select.submissions).toEqual({
      where: { userId: "alice", status: "APPROVED" },
      select: { id: true },
      take: 1,
    });
    expect(args.select.description).toBeUndefined();
    expect(args.select.instructions).toBeUndefined();
    expect(args.select.terms).toBeUndefined();
    expect(args.skip).toBe(10);
    expect(args.take).toBe(10);
    expect(count).toHaveBeenCalledWith({ where: args.where });
    expect(cards[0]?.completed).toBe(true);
    expect(total).toBe(1);
  });

  it("anonymous lists never query user submissions and use a deterministic tie-breaker", async () => {
    const findMany = vi.fn(async (_args: unknown) => []);
    const repo = new HotOffersRepository({
      offer: { findMany, count: vi.fn(async () => 0) },
    } as unknown as PrismaClient);
    await repo.listOfferCards({ page: 1, limit: 10, sort: "reward" });
    const args = findMany.mock.calls[0]![0] as Record<string, any>;
    expect(args.select.submissions).toBeUndefined();
    expect(args.where.NOT).toBeUndefined();
    expect(args.orderBy.at(-1)).toEqual({ id: "asc" });
  });
});
