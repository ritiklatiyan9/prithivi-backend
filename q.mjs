import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const now = new Date();
const g = await p.ludoQueueEntry.groupBy({ by: ["status", "mode"], _count: { _all: true } });
console.log("queue by status:", JSON.stringify(g));
const live = await p.ludoQueueEntry.findMany({
  where: { status: "QUEUED" },
  select: { userId: true, mode: true, joinedAt: true, expiresAt: true },
  take: 20,
});
console.log("QUEUED entries:", live.length, live.map((e) => ({ mode: e.mode, expired: e.expiresAt <= now })));
const rooms = await p.ludoRoom.groupBy({ by: ["status"], _count: { _all: true } });
console.log("rooms by status:", JSON.stringify(rooms));
await p.$disconnect();
