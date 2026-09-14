import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { HotOffersRepository } from "../src/modules/hot-offers/repositories/hot-offers.repository.js";
import { UsersRepository } from "../src/modules/users/repositories/users.repository.js";

// Read-only validation; logs counts/timing, never user or offer payloads.
const prisma = new PrismaClient();
async function main() {
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '15s'`;
        const offers = new HotOffersRepository(tx as unknown as PrismaClient);
        const users = new UsersRepository(tx as unknown as PrismaClient);
        const started = performance.now();
        const [cards, total] = await offers.listOfferCards({
          page: 1,
          limit: 10,
          sort: "priority",
        });
        const cardMs = performance.now() - started;
        const leaderboardStarted = performance.now();
        const board = await users.topEarnersSince(new Date(Date.now() - 86_400_000), 10);
        console.log(
          JSON.stringify({
            readOnly: true,
            cards: cards.length,
            totalOffers: total,
            cardReadMs: Math.round(cardMs),
            leaderboardRows: board.length,
            leaderboardReadMs: Math.round(performance.now() - leaderboardStarted),
          }),
        );
      },
      { timeout: 30_000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error(JSON.stringify({ validationFailed: true, code: error.code ?? error.name }));
  process.exitCode = 1;
});
