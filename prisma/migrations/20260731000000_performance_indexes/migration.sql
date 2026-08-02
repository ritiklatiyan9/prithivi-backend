-- Indexes aligned with the admin queue filters/sorts and the app's hottest
-- wallet/session lookups. Replacing single-column indexes keeps write overhead
-- bounded because PostgreSQL can still use the leading column of each compound
-- index for the original equality filters.

CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");
CREATE INDEX "users_referredById_referredAt_idx" ON "users"("referredById", "referredAt");

DROP INDEX IF EXISTS "campaigns_status_idx";
CREATE INDEX "campaigns_status_createdAt_idx" ON "campaigns"("status", "createdAt");

DROP INDEX IF EXISTS "claims_userId_idx";
DROP INDEX IF EXISTS "claims_status_idx";
CREATE INDEX "claims_userId_createdAt_idx" ON "claims"("userId", "createdAt");
CREATE INDEX "claims_status_createdAt_idx" ON "claims"("status", "createdAt");

CREATE INDEX "wallet_transactions_walletId_type_createdAt_idx"
  ON "wallet_transactions"("walletId", "type", "createdAt");

CREATE INDEX "push_logs_status_scheduledAt_idx" ON "push_logs"("status", "scheduledAt");
CREATE INDEX "analytics_events_createdAt_idx" ON "analytics_events"("createdAt");
CREATE INDEX "offers_status_createdAt_idx" ON "offers"("status", "createdAt");

DROP INDEX IF EXISTS "offer_submissions_userId_idx";
CREATE INDEX "offer_submissions_userId_createdAt_idx"
  ON "offer_submissions"("userId", "createdAt");
CREATE INDEX "offer_submissions_userId_status_idx"
  ON "offer_submissions"("userId", "status");

DROP INDEX IF EXISTS "redemptions_userId_idx";
DROP INDEX IF EXISTS "redemptions_status_idx";
DROP INDEX IF EXISTS "redemptions_method_status_idx";
CREATE INDEX "redemptions_userId_createdAt_idx" ON "redemptions"("userId", "createdAt");
CREATE INDEX "redemptions_userId_status_createdAt_idx"
  ON "redemptions"("userId", "status", "createdAt");
CREATE INDEX "redemptions_status_createdAt_idx" ON "redemptions"("status", "createdAt");
CREATE INDEX "redemptions_method_status_createdAt_idx"
  ON "redemptions"("method", "status", "createdAt");
CREATE INDEX "redemptions_voucherOfferId_idx" ON "redemptions"("voucherOfferId");

DROP INDEX IF EXISTS "mission_completions_userId_idx";
DROP INDEX IF EXISTS "mission_completions_status_idx";
CREATE INDEX "mission_completions_userId_createdAt_idx"
  ON "mission_completions"("userId", "createdAt");
CREATE INDEX "mission_completions_status_createdAt_idx"
  ON "mission_completions"("status", "createdAt");
