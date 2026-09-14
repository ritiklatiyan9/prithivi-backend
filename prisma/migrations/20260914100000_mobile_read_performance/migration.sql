-- Additive indexes for mobile feeds. Existing indexes and data are retained.
CREATE INDEX "wallet_transactions_type_createdAt_idx"
  ON "wallet_transactions" ("type", "createdAt");
CREATE INDEX "notifications_userId_readAt_createdAt_idx"
  ON "notifications" ("userId", "readAt", "createdAt");
CREATE INDEX "offers_public_feed_idx"
  ON "offers" ("status", "deletedAt", "featured" DESC, "priority" DESC, "createdAt" DESC);
