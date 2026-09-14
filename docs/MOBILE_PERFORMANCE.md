# Mobile read performance — 14 September 2026

Offer feeds now select only card fields, rather than loading detail descriptions and JSON instructions for every row. Signed-in feeds filter completed HIDE offers in the database and inspect completion only for the requested page. Counts use the same filter; ordering includes an ID tie-breaker. Anonymous responses retain the existing bounded 30-second cache. Personalized responses are never stored in that shared cache.

Wallet summaries combine credit counts, credit totals, and debit totals in one grouped query. Existing wallets use a read instead of an upsert. A normal summary uses three database queries instead of four, while totals remain derived from the ledger.

The daily leaderboard uses one parameterized aggregate/join instead of fetching aggregates and users in separate round trips. Inactive users are filtered before the limit; redemption refunds remain excluded. Only public name, avatar, and coin totals are returned.

API responses include `Server-Timing: api;dur=...` to distinguish server processing time from network latency.

## Database rollout

Migration `20260914100000_mobile_read_performance` was applied to the configured Neon database on 14 September 2026 after user approval. PostgreSQL reports all three indexes as valid and ready:

- `wallet_transactions_type_createdAt_idx`
- `notifications_userId_readAt_createdAt_idx`
- `offers_public_feed_idx`

The migration only adds indexes. No existing indexes, application rows, or migration records were removed. The database has a historical applied `20260711160000_withdrawals` migration absent from this checkout; it was left untouched. The new migration completed successfully through `npm run prisma:deploy`.

## Validation

- `npm run build`: passed.
- `npm test`: 163 tests passed across 23 files.
- `npx prisma validate`: passed.
- `npx tsx scripts/verify-mobile-reads.ts`: ran the new offer and leaderboard queries against the configured database in a read-only transaction. It logs counts/timing only, without user payloads.
- `git diff --check`: passed.

Tests cover lightweight offer selection, identical list/count visibility filters, wallet grouped totals, and existing completion behavior. Live SQL execution verifies that the parameterized leaderboard query is accepted by PostgreSQL.

These changes reduce database work and round trips. They are not a measured app-wide speed multiplier. Compare representative p50/p95 timings after deployment, including cold starts and mobile network latency.

## API deployment status

The API changes are built and tested, but not yet published. The live Render service's repository/branch must be confirmed before pushing: the checkout has both `ritiklatiyan9/prithivi-backend` and `harshdevloper/prithivi-backend` remotes, and an earlier local referral commit is not on `origin/dev`. No Render deployment credential is configured in this workspace. The browser connection could not initialize. The live health endpoint returned HTTP 200 before code deployment.

## References

- [Prisma field selection](https://www.prisma.io/docs/orm/v6/prisma-client/queries/select-fields)
- [Prisma indexes](https://docs.prisma.io/docs/orm/prisma-schema/data-model/indexes)
