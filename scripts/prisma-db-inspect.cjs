#!/usr/bin/env node

const { PrismaClient } = require("@prisma/client");

const command = process.argv[2];

async function main() {
  if (command === "database-url") {
    const envPath = process.argv[3];
    const { readFileSync } = require("node:fs");
    const { parse } = require("dotenv");
    const fileEnvironment = parse(readFileSync(envPath));
    process.stdout.write(
      fileEnvironment.DATABASE_URL_UNPOOLED ?? fileEnvironment.DATABASE_URL ?? "",
    );
    return;
  }

  const prisma = new PrismaClient();

  try {
    if (command === "connection") {
      await prisma.$queryRawUnsafe("SELECT 1");
      console.log("OK");
      return;
    }

    if (command === "migration-state") {
      const migrationName = process.argv[3] ?? "20260713080000_add_offer_product_fields";
      const rows = await prisma.$queryRawUnsafe(
        `
      SELECT CASE
        WHEN EXISTS (
          SELECT 1
          FROM "_prisma_migrations"
          WHERE migration_name = $1
            AND finished_at IS NOT NULL
        ) THEN 'APPLIED'
        WHEN EXISTS (
          SELECT 1
          FROM "_prisma_migrations"
          WHERE migration_name = $1
            AND rolled_back_at IS NULL
            AND finished_at IS NULL
        ) THEN 'FAILED'
        ELSE 'MISSING'
      END AS state
    `,
        migrationName,
      );
      console.log(rows[0]?.state ?? "MISSING");
      return;
    }

    if (command === "offers-columns") {
      const rows = await prisma.$queryRawUnsafe(`
      SELECT (
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'offers'
            AND column_name = 'isProduct'
        )
        AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'offers'
            AND column_name = 'brandLogoUrl'
        )
      ) AS ready
    `);
      console.log(rows[0]?.ready ? "READY" : "MISSING");
      return;
    }

    if (command === "coin-purchases-table") {
      const rows = await prisma.$queryRawUnsafe(`
      SELECT to_regclass('public.coin_purchases') IS NOT NULL AS ready
    `);
      console.log(rows[0]?.ready ? "READY" : "MISSING");
      return;
    }

    if (command === "roulette-schema" || command === "roulette-base-status") {
      const enumRows = await prisma.$queryRawUnsafe(`
      SELECT typname AS name
      FROM pg_type
      WHERE typname IN (
        'RouletteBetType',
        'RouletteRoundStatus',
        'RouletteProbabilityMode'
      )
      ORDER BY typname
    `);
      const tableRows = await prisma.$queryRawUnsafe(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'roulette_probability_profiles',
          'roulette_rounds'
        )
      ORDER BY table_name
    `);
      const indexRows = await prisma.$queryRawUnsafe(`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname LIKE 'roulette_%'
      ORDER BY indexname
    `);
      const columnRows = await prisma.$queryRawUnsafe(`
      SELECT table_name AS table, column_name AS name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'roulette_probability_profiles',
          'roulette_rounds'
        )
      ORDER BY table_name, ordinal_position
    `);
      const constraintRows = await prisma.$queryRawUnsafe(`
      SELECT conname AS name
      FROM pg_constraint
      WHERE conname IN (
        'roulette_rounds_userId_fkey',
        'roulette_rounds_probabilityProfileId_fkey'
      )
      ORDER BY conname
    `);

      const schema = {
        enums: enumRows.map((row) => row.name),
        tables: tableRows.map((row) => row.name),
        columns: columnRows,
        indexes: indexRows.map((row) => row.name),
        constraints: constraintRows.map((row) => row.name),
      };

      if (command === "roulette-schema") {
        console.log(JSON.stringify(schema));
        return;
      }

      const expectedEnums = ["RouletteBetType", "RouletteProbabilityMode", "RouletteRoundStatus"];
      const expectedTables = ["roulette_probability_profiles", "roulette_rounds"];
      const expectedColumns = {
        roulette_probability_profiles: [
          "id",
          "name",
          "mode",
          "numberWeights",
          "estimatedRtp",
          "active",
          "effectiveFrom",
          "createdById",
          "createdAt",
        ],
        roulette_rounds: [
          "id",
          "userId",
          "betType",
          "selectedNumber",
          "betAmount",
          "usedFreeGame",
          "winningNumber",
          "winningColour",
          "parity",
          "won",
          "payoutMultiplier",
          "payoutAmount",
          "netResult",
          "status",
          "probabilityMode",
          "configSnapshot",
          "probabilityProfileId",
          "serverSeed",
          "serverSeedHash",
          "clientSeed",
          "nonce",
          "idempotencyKey",
          "createdAt",
          "settledAt",
        ],
      };
      const expectedIndexes = [
        "roulette_probability_profiles_active_idx",
        "roulette_rounds_betType_idx",
        "roulette_rounds_createdAt_idx",
        "roulette_rounds_probabilityProfileId_idx",
        "roulette_rounds_userId_createdAt_idx",
        "roulette_rounds_userId_idempotencyKey_key",
        "roulette_rounds_winningNumber_idx",
      ];
      const expectedConstraints = [
        "roulette_rounds_probabilityProfileId_fkey",
        "roulette_rounds_userId_fkey",
      ];
      const hasAll = (actual, expected) => expected.every((name) => actual.includes(name));
      const actualColumns = new Set(
        schema.columns.map((column) => `${column.table}.${column.name}`),
      );
      const columnsReady = Object.entries(expectedColumns).every(([table, columns]) =>
        columns.every((column) => actualColumns.has(`${table}.${column}`)),
      );

      const ready =
        hasAll(schema.enums, expectedEnums) &&
        hasAll(schema.tables, expectedTables) &&
        columnsReady &&
        hasAll(schema.indexes, expectedIndexes) &&
        hasAll(schema.constraints, expectedConstraints);

      console.log(ready ? "READY" : "INCOMPLETE");
      return;
    }

    throw new Error(`Unknown inspection command: ${command ?? "(missing)"}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
