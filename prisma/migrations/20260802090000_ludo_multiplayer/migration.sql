-- Durable, server-authoritative Ludo rooms, communication, moderation and
-- Razorpay-backed subscription entitlements. All additions are additive.

CREATE TYPE "LudoGameMode" AS ENUM ('TWO_PLAYER', 'THREE_PLAYER', 'FOUR_PLAYER');
CREATE TYPE "LudoQueueStatus" AS ENUM ('QUEUED', 'MATCHED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE "LudoRoomStatus" AS ENUM ('MATCHED', 'WAITING_READY', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'ABANDONED', 'EXPIRED');
CREATE TYPE "LudoPlayerStatus" AS ENUM ('MATCHED', 'ACCEPTED', 'READY', 'ACTIVE', 'DISCONNECTED', 'FORFEITED', 'FINISHED');
CREATE TYPE "LudoMessageType" AS ENUM ('QUICK', 'TEXT');
CREATE TYPE "LudoPlan" AS ENUM ('FREE', 'PLUS', 'PRO');
CREATE TYPE "LudoSubscriptionStatus" AS ENUM ('PENDING', 'AUTHENTICATED', 'ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED', 'EXPIRED', 'PAYMENT_FAILED');
CREATE TYPE "LudoPaymentEventStatus" AS ENUM ('PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED');
CREATE TYPE "LudoReportStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');
CREATE TYPE "LudoRestrictionType" AS ENUM ('GAME_ACCESS', 'COMMUNICATION', 'TEXT_CHAT', 'VOICE_CHAT');

CREATE TABLE "ludo_rooms" (
  "id" TEXT NOT NULL,
  "mode" "LudoGameMode" NOT NULL,
  "status" "LudoRoomStatus" NOT NULL DEFAULT 'MATCHED',
  "state" JSONB NOT NULL,
  "configSnapshot" JSONB NOT NULL,
  "stateVersion" INTEGER NOT NULL DEFAULT 0,
  "acceptanceDeadline" TIMESTAMPTZ(3),
  "turnDeadline" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "cancelledReason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ludo_rooms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ludo_rooms_state_version_nonnegative" CHECK ("stateVersion" >= 0)
);

CREATE TABLE "ludo_queue_entries" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mode" "LudoGameMode" NOT NULL,
  "status" "LudoQueueStatus" NOT NULL DEFAULT 'QUEUED',
  "region" TEXT,
  "pingMs" INTEGER,
  "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "matchedRoomId" TEXT,
  "acceptedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ludo_queue_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ludo_queue_ping_range" CHECK ("pingMs" IS NULL OR ("pingMs" >= 0 AND "pingMs" <= 60000))
);

CREATE TABLE "ludo_players" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "seat" INTEGER NOT NULL,
  "color" TEXT NOT NULL,
  "status" "LudoPlayerStatus" NOT NULL DEFAULT 'MATCHED',
  "activeKey" TEXT,
  "resumeTokenHash" TEXT NOT NULL,
  "lastAcknowledgedVersion" INTEGER NOT NULL DEFAULT 0,
  "acceptedAt" TIMESTAMPTZ(3),
  "readyAt" TIMESTAMPTZ(3),
  "disconnectedAt" TIMESTAMPTZ(3),
  "reconnectDeadline" TIMESTAMPTZ(3),
  "finishedPosition" INTEGER,
  "captures" INTEGER NOT NULL DEFAULT 0,
  "diceRolls" INTEGER NOT NULL DEFAULT 0,
  "pawnsCompleted" INTEGER NOT NULL DEFAULT 0,
  "turnTimeouts" INTEGER NOT NULL DEFAULT 0,
  "disconnectCount" INTEGER NOT NULL DEFAULT 0,
  "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ludo_players_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ludo_players_seat_range" CHECK ("seat" >= 0 AND "seat" < 4),
  CONSTRAINT "ludo_players_versions_nonnegative" CHECK ("lastAcknowledgedVersion" >= 0)
);

CREATE TABLE "ludo_actions" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" TEXT,
  "actionId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "stateVersion" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "serverEvent" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ludo_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ludo_statistics" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "totalMatches" INTEGER NOT NULL DEFAULT 0,
  "wins" INTEGER NOT NULL DEFAULT 0,
  "losses" INTEGER NOT NULL DEFAULT 0,
  "twoPlayerMatches" INTEGER NOT NULL DEFAULT 0,
  "threePlayerMatches" INTEGER NOT NULL DEFAULT 0,
  "fourPlayerMatches" INTEGER NOT NULL DEFAULT 0,
  "disconnects" INTEGER NOT NULL DEFAULT 0,
  "forfeits" INTEGER NOT NULL DEFAULT 0,
  "captures" INTEGER NOT NULL DEFAULT 0,
  "diceRolls" INTEGER NOT NULL DEFAULT 0,
  "pawnsCompleted" INTEGER NOT NULL DEFAULT 0,
  "totalDurationSeconds" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ludo_statistics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ludo_chat_messages" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientActionId" TEXT NOT NULL,
  "type" "LudoMessageType" NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ludo_chat_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ludo_chat_content_length" CHECK (char_length("content") BETWEEN 1 AND 200)
);

CREATE TABLE "ludo_voice_sessions" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ludo_voice_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ludo_voice_participants" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMPTZ(3),
  "connectionFailures" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ludo_voice_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ludo_user_blocks" (
  "userId" TEXT NOT NULL,
  "blockedUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ludo_user_blocks_pkey" PRIMARY KEY ("userId", "blockedUserId"),
  CONSTRAINT "ludo_user_blocks_not_self" CHECK ("userId" <> "blockedUserId")
);

CREATE TABLE "ludo_user_mutes" (
  "roomId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mutedUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ludo_user_mutes_pkey" PRIMARY KEY ("roomId", "userId", "mutedUserId"),
  CONSTRAINT "ludo_user_mutes_not_self" CHECK ("userId" <> "mutedUserId")
);

CREATE TABLE "ludo_reports" (
  "id" TEXT NOT NULL,
  "roomId" TEXT,
  "reporterId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "messageId" TEXT,
  "category" TEXT NOT NULL,
  "details" TEXT,
  "status" "LudoReportStatus" NOT NULL DEFAULT 'OPEN',
  "resolution" TEXT,
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ludo_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ludo_reports_not_self" CHECK ("reporterId" <> "targetUserId")
);

CREATE TABLE "ludo_restrictions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "LudoRestrictionType" NOT NULL,
  "reason" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ludo_restrictions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ludo_subscriptions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "plan" "LudoPlan" NOT NULL,
  "status" "LudoSubscriptionStatus" NOT NULL DEFAULT 'PENDING',
  "razorpayCustomerId" TEXT,
  "razorpaySubscriptionId" TEXT NOT NULL,
  "razorpayPlanId" TEXT NOT NULL,
  "latestPaymentId" TEXT,
  "currentPeriodStart" TIMESTAMPTZ(3),
  "currentPeriodEnd" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ludo_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ludo_entitlements" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "plan" "LudoPlan" NOT NULL DEFAULT 'FREE',
  "status" "LudoSubscriptionStatus" NOT NULL DEFAULT 'EXPIRED',
  "sourceSubscriptionId" TEXT,
  "startsAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ludo_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ludo_payment_events" (
  "id" TEXT NOT NULL,
  "razorpayEventId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" "LudoPaymentEventStatus" NOT NULL DEFAULT 'PROCESSING',
  "subscriptionRecordId" TEXT,
  "razorpayPaymentId" TEXT,
  "summary" JSONB,
  "error" TEXT,
  "processedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ludo_payment_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ludo_queue_entries_userId_key" ON "ludo_queue_entries"("userId");
CREATE INDEX "ludo_queue_entries_mode_status_joinedAt_idx" ON "ludo_queue_entries"("mode", "status", "joinedAt");
CREATE INDEX "ludo_queue_entries_status_expiresAt_idx" ON "ludo_queue_entries"("status", "expiresAt");
CREATE INDEX "ludo_rooms_status_createdAt_idx" ON "ludo_rooms"("status", "createdAt");
CREATE INDEX "ludo_rooms_mode_status_createdAt_idx" ON "ludo_rooms"("mode", "status", "createdAt");
CREATE INDEX "ludo_rooms_status_turnDeadline_idx" ON "ludo_rooms"("status", "turnDeadline");
CREATE UNIQUE INDEX "ludo_players_activeKey_key" ON "ludo_players"("activeKey");
CREATE UNIQUE INDEX "ludo_players_resumeTokenHash_key" ON "ludo_players"("resumeTokenHash");
CREATE UNIQUE INDEX "ludo_players_roomId_userId_key" ON "ludo_players"("roomId", "userId");
CREATE UNIQUE INDEX "ludo_players_roomId_seat_key" ON "ludo_players"("roomId", "seat");
CREATE INDEX "ludo_players_userId_status_updatedAt_idx" ON "ludo_players"("userId", "status", "updatedAt");
CREATE INDEX "ludo_players_roomId_status_idx" ON "ludo_players"("roomId", "status");
CREATE UNIQUE INDEX "ludo_actions_roomId_actionId_key" ON "ludo_actions"("roomId", "actionId");
CREATE UNIQUE INDEX "ludo_actions_roomId_stateVersion_key" ON "ludo_actions"("roomId", "stateVersion");
CREATE INDEX "ludo_actions_roomId_createdAt_idx" ON "ludo_actions"("roomId", "createdAt");
CREATE INDEX "ludo_actions_userId_createdAt_idx" ON "ludo_actions"("userId", "createdAt");
CREATE UNIQUE INDEX "ludo_statistics_userId_key" ON "ludo_statistics"("userId");
CREATE UNIQUE INDEX "ludo_chat_messages_roomId_userId_clientActionId_key" ON "ludo_chat_messages"("roomId", "userId", "clientActionId");
CREATE INDEX "ludo_chat_messages_roomId_createdAt_idx" ON "ludo_chat_messages"("roomId", "createdAt");
CREATE INDEX "ludo_chat_messages_userId_createdAt_idx" ON "ludo_chat_messages"("userId", "createdAt");
CREATE UNIQUE INDEX "ludo_voice_sessions_roomId_key" ON "ludo_voice_sessions"("roomId");
CREATE UNIQUE INDEX "ludo_voice_participants_sessionId_userId_key" ON "ludo_voice_participants"("sessionId", "userId");
CREATE INDEX "ludo_voice_participants_userId_joinedAt_idx" ON "ludo_voice_participants"("userId", "joinedAt");
CREATE INDEX "ludo_user_blocks_blockedUserId_idx" ON "ludo_user_blocks"("blockedUserId");
CREATE INDEX "ludo_user_mutes_mutedUserId_idx" ON "ludo_user_mutes"("mutedUserId");
CREATE INDEX "ludo_reports_status_createdAt_idx" ON "ludo_reports"("status", "createdAt");
CREATE INDEX "ludo_reports_targetUserId_createdAt_idx" ON "ludo_reports"("targetUserId", "createdAt");
CREATE INDEX "ludo_reports_roomId_createdAt_idx" ON "ludo_reports"("roomId", "createdAt");
CREATE INDEX "ludo_restrictions_userId_type_expiresAt_idx" ON "ludo_restrictions"("userId", "type", "expiresAt");
CREATE INDEX "ludo_restrictions_createdAt_idx" ON "ludo_restrictions"("createdAt");
CREATE UNIQUE INDEX "ludo_subscriptions_razorpaySubscriptionId_key" ON "ludo_subscriptions"("razorpaySubscriptionId");
CREATE INDEX "ludo_subscriptions_userId_createdAt_idx" ON "ludo_subscriptions"("userId", "createdAt");
CREATE INDEX "ludo_subscriptions_userId_status_currentPeriodEnd_idx" ON "ludo_subscriptions"("userId", "status", "currentPeriodEnd");
CREATE INDEX "ludo_subscriptions_razorpayCustomerId_idx" ON "ludo_subscriptions"("razorpayCustomerId");
CREATE UNIQUE INDEX "ludo_entitlements_userId_key" ON "ludo_entitlements"("userId");
CREATE INDEX "ludo_entitlements_status_expiresAt_idx" ON "ludo_entitlements"("status", "expiresAt");
CREATE UNIQUE INDEX "ludo_payment_events_razorpayEventId_key" ON "ludo_payment_events"("razorpayEventId");
CREATE INDEX "ludo_payment_events_status_createdAt_idx" ON "ludo_payment_events"("status", "createdAt");
CREATE INDEX "ludo_payment_events_razorpayPaymentId_idx" ON "ludo_payment_events"("razorpayPaymentId");
CREATE INDEX "ludo_payment_events_subscriptionRecordId_createdAt_idx" ON "ludo_payment_events"("subscriptionRecordId", "createdAt");

ALTER TABLE "ludo_queue_entries" ADD CONSTRAINT "ludo_queue_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_queue_entries" ADD CONSTRAINT "ludo_queue_entries_matchedRoomId_fkey" FOREIGN KEY ("matchedRoomId") REFERENCES "ludo_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ludo_players" ADD CONSTRAINT "ludo_players_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ludo_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_players" ADD CONSTRAINT "ludo_players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_actions" ADD CONSTRAINT "ludo_actions_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ludo_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_statistics" ADD CONSTRAINT "ludo_statistics_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_chat_messages" ADD CONSTRAINT "ludo_chat_messages_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ludo_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_chat_messages" ADD CONSTRAINT "ludo_chat_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_voice_sessions" ADD CONSTRAINT "ludo_voice_sessions_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ludo_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_voice_participants" ADD CONSTRAINT "ludo_voice_participants_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ludo_voice_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_voice_participants" ADD CONSTRAINT "ludo_voice_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_user_blocks" ADD CONSTRAINT "ludo_user_blocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_user_blocks" ADD CONSTRAINT "ludo_user_blocks_blockedUserId_fkey" FOREIGN KEY ("blockedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_user_mutes" ADD CONSTRAINT "ludo_user_mutes_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ludo_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_user_mutes" ADD CONSTRAINT "ludo_user_mutes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_user_mutes" ADD CONSTRAINT "ludo_user_mutes_mutedUserId_fkey" FOREIGN KEY ("mutedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_reports" ADD CONSTRAINT "ludo_reports_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ludo_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ludo_reports" ADD CONSTRAINT "ludo_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_reports" ADD CONSTRAINT "ludo_reports_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_reports" ADD CONSTRAINT "ludo_reports_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ludo_restrictions" ADD CONSTRAINT "ludo_restrictions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_restrictions" ADD CONSTRAINT "ludo_restrictions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ludo_subscriptions" ADD CONSTRAINT "ludo_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_entitlements" ADD CONSTRAINT "ludo_entitlements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ludo_payment_events" ADD CONSTRAINT "ludo_payment_events_subscriptionRecordId_fkey" FOREIGN KEY ("subscriptionRecordId") REFERENCES "ludo_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
