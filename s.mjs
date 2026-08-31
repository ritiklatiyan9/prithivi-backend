import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const rows = await p.setting.findMany({
  where: { key: { startsWith: "game.ludo" } },
  select: { key: true, value: true },
});
console.log(rows.map((r) => `${r.key}=${JSON.stringify(r.value)}`).join("\n"));
await p.$disconnect();
