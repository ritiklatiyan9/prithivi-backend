import { Prisma, type PrismaClient, type User } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { UsersService } from "./users.service.js";
import { UsersRepository } from "../repositories/users.repository.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import { applyReferralSchema, toPublicUser } from "../schemas/users.schema.js";
import { readReferralPolicy } from "./referral-policy.js";

function harness() {
  let accounts = [
    {
      id: "friend",
      name: "Friend",
      referralCode: "FRIEND01",
      isActive: true,
      referredById: null,
      referredAt: null,
    },
    {
      id: "owner",
      name: "Owner",
      referralCode: "OWNER001",
      isActive: true,
      referredById: null,
      referredAt: null,
    },
    {
      id: "other",
      name: "Other",
      referralCode: "OTHER001",
      isActive: true,
      referredById: null,
      referredAt: null,
    },
  ] as User[];
  let balances: Record<string, number> = { owner: 100, friend: 10, other: 0 };
  let entries: Array<{
    walletId: string;
    amount: Prisma.Decimal;
    reference: string;
    balanceAfter: number;
  }> = [];
  const policy = { enabled: true, owner: 75, friend: 20 };
  let failReference = "";
  const setting = {
    findMany: vi.fn(async () => [
      { key: "referral.enabled", value: String(policy.enabled) },
      { key: "referral.rewardPoints", value: String(policy.owner) },
      { key: "referral.inviteeRewardPoints", value: String(policy.friend) },
    ]),
  };
  const lock = vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => accounts);
  const tx = {
    $queryRaw: lock,
    setting,
    user: {
      updateMany: vi.fn(async ({ where, data }) => {
        const user = accounts.find(
          (u) =>
            u.id === where.id && u.referredAt === null && u.referredById === null && u.isActive,
        );
        if (!user) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      }),
    },
    wallet: {
      upsert: vi.fn(async ({ where }) => ({ id: where.userId })),
      update: vi.fn(async ({ where, data }) => {
        balances[where.id] += data.balance.increment;
        return { balance: balances[where.id] };
      }),
    },
    walletTransaction: {
      findMany: vi.fn(async () => entries),
      create: vi.fn(async ({ data }) => {
        if (data.reference === failReference) throw new Error("Ledger unavailable");
        entries.push(data);
        return data;
      }),
    },
  };
  // Transaction test double models row-lock serialization and rollback. These
  // tests exercise service outcomes; they are not a PostgreSQL integration test.
  let tail = Promise.resolve();
  const prisma = {
    setting,
    $transaction: vi.fn((fn: (value: typeof tx) => Promise<unknown>) => {
      const run = tail.then(async () => {
        const oldAccounts = structuredClone(accounts),
          oldBalances = { ...balances },
          oldEntries = [...entries];
        try {
          return await fn(tx);
        } catch (e) {
          accounts = oldAccounts;
          balances = oldBalances;
          entries = oldEntries;
          throw e;
        }
      });
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    }),
  };
  const repo = {
    findByReferralCode: vi.fn(
      async (code: string) => accounts.find((u) => u.referralCode === code) ?? null,
    ),
  };
  const enqueue = vi.fn(async () => {});
  const service = new UsersService(
    prisma as unknown as PrismaClient,
    repo as unknown as UsersRepository,
    {} as SettingsService,
    { enqueue } as unknown as NotificationsService,
    {} as FastifyInstance,
  );
  return {
    service,
    policy,
    enqueue,
    lock,
    tx,
    repo,
    get accounts() {
      return accounts;
    },
    get balances() {
      return balances;
    },
    get entries() {
      return entries;
    },
    failLedger: (reference: string) => {
      failReference = reference;
    },
  };
}

describe("referral reward settlement", () => {
  it("normalizes the code and credits both admin-defined amounts in one transaction", async () => {
    const h = harness();
    expect(await h.service.applyReferral("friend", " owner001 ")).toEqual({
      applied: true,
      alreadyApplied: false,
      rewardPoints: 75,
      inviteeRewardPoints: 20,
    });
    expect(h.balances).toEqual({ owner: 175, friend: 30, other: 0 });
    expect(h.entries.map((e) => [e.reference, Number(e.amount), e.balanceAfter])).toEqual([
      ["referral-join:friend", 20, 30],
      ["referral:friend", 75, 175],
    ]);
    expect(h.accounts[0].referredById).toBe("owner");
    expect(h.lock.mock.calls[0][0].join("?")).toContain("ORDER BY id FOR UPDATE");
  });
  it("returns the original receipt on retry after amounts change or referrals pause", async () => {
    const h = harness();
    await h.service.applyReferral("friend", "OWNER001");
    h.policy.owner = 900;
    h.policy.friend = 800;
    h.policy.enabled = false;
    expect(await h.service.applyReferral("friend", "OWNER001")).toMatchObject({
      alreadyApplied: true,
      rewardPoints: 75,
      inviteeRewardPoints: 20,
    });
    expect(h.entries).toHaveLength(2);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
  });
  it("settles duplicate simultaneous requests only once", async () => {
    const h = harness();
    const results = await Promise.all([
      h.service.applyReferral("friend", "OWNER001"),
      h.service.applyReferral("friend", "owner001"),
    ]);
    expect(results.filter((r) => !r.alreadyApplied)).toHaveLength(1);
    expect(h.entries).toHaveLength(2);
    expect(h.balances.friend).toBe(30);
  });
  it("allows only one of two competing inviter codes", async () => {
    const h = harness();
    const results = await Promise.allSettled([
      h.service.applyReferral("friend", "OWNER001"),
      h.service.applyReferral("friend", "OTHER001"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.entries).toHaveLength(2);
    expect(h.balances.other).toBe(0);
  });
  it("rolls back eligibility and both balances if either ledger write fails", async () => {
    const h = harness();
    h.failLedger("referral:friend");
    await expect(h.service.applyReferral("friend", "OWNER001")).rejects.toThrow(
      "Ledger unavailable",
    );
    expect(h.balances).toEqual({ owner: 100, friend: 10, other: 0 });
    expect(h.accounts[0].referredAt).toBeNull();
    expect(h.entries).toHaveLength(0);
    h.failLedger("");
    await h.service.applyReferral("friend", "OWNER001");
    expect(h.balances.friend).toBe(30);
  });
  it("does not fail an already committed claim when notifications fail", async () => {
    const h = harness();
    h.enqueue.mockRejectedValue(new Error("Push unavailable"));
    await expect(h.service.applyReferral("friend", "OWNER001")).resolves.toMatchObject({
      applied: true,
    });
    expect(h.entries).toHaveLength(2);
  });
  it("records zero bonuses without inventing rewards or sending zero-value notifications", async () => {
    const h = harness();
    h.policy.owner = 0;
    h.policy.friend = 0;
    await h.service.applyReferral("friend", "OWNER001");
    expect(h.balances).toEqual({ owner: 100, friend: 10, other: 0 });
    expect(h.entries).toHaveLength(2);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each([
    "self",
    "unknown",
    "inactive inviter",
    "inactive friend",
    "previous claim",
    "deleted inviter",
    "reciprocal",
    "paused",
    "invalid",
  ])("rejects %s without crediting", async (scenario) => {
    const h = harness();
    let code = "OWNER001";
    if (scenario === "self") code = "FRIEND01";
    if (scenario === "unknown") code = "MISSING";
    if (scenario === "invalid") code = "bad code!";
    if (scenario === "inactive inviter") h.accounts[1].isActive = false;
    if (scenario === "inactive friend") h.accounts[0].isActive = false;
    if (scenario === "previous claim") h.accounts[0].referredById = "other";
    if (scenario === "deleted inviter") h.accounts[0].referredAt = new Date();
    if (scenario === "reciprocal") h.accounts[1].referredById = "friend";
    if (scenario === "paused") h.policy.enabled = false;
    await expect(h.service.applyReferral("friend", code)).rejects.toThrow();
    expect(h.entries).toHaveLength(0);
    expect(h.tx.wallet.update).not.toHaveBeenCalled();
  });
});

describe("referral contracts", () => {
  it("keeps a previous claim in the public profile after inviter deletion", () => {
    expect(
      toPublicUser({
        ...harness().accounts[0],
        createdAt: new Date(),
        referredAt: new Date(),
      } as User).hasAppliedReferral,
    ).toBe(true);
  });
  it("accepts trimmed mixed-case codes and rejects punctuation", () => {
    expect(applyReferralSchema.parse({ code: " owner001 " }).code).toBe("OWNER001");
    expect(applyReferralSchema.safeParse({ code: "OWNER-001" }).success).toBe(false);
  });
  it("returns existing defaults without inventing a joining reward", async () => {
    expect(await readReferralPolicy({ setting: { findMany: async () => [] } } as never)).toEqual({
      enabled: true,
      rewardPoints: 50,
      inviteeRewardPoints: 0,
    });
  });
  it.each(["-1", "1.5", "NaN", "1000001", ""])("rejects unsafe stored reward %s", async (value) => {
    expect(
      (
        await readReferralPolicy({
          setting: { findMany: async () => [{ key: "referral.inviteeRewardPoints", value }] },
        } as never)
      ).inviteeRewardPoints,
    ).toBe(0);
  });
  it("never replaces an invite code generated by a concurrent request", async () => {
    const h = harness();
    const user = { ...h.accounts[0], referralCode: null };
    const stored = { ...user, referralCode: "STABLE01" };
    const updateMany = vi.fn(async (_args: { where: { id: string; referralCode: null } }) => ({
      count: 0,
    }));
    const repo = new UsersRepository({
      user: { updateMany, findUniqueOrThrow: async () => stored },
    } as unknown as PrismaClient);
    expect((await repo.ensureReferralCode(user)).referralCode).toBe("STABLE01");
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "friend", referralCode: null });
  });
});
