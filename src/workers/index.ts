import type { FastifyInstance } from "fastify";
import type { PushLog } from "@prisma/client";
import type { NotificationJob } from "../modules/notifications/queues/notification.queue.js";
import { dispatchNotification } from "../modules/notifications/services/notification-dispatcher.js";

/** How often the scheduler looks for due scheduled sends. */
const POLL_INTERVAL_MS = 30_000;

/** Rebuild the delivery job from the PushLog row the admin send created. */
const jobFromPushLog = (log: PushLog): NotificationJob => ({
  audience: log.audience as NotificationJob["audience"],
  userId: log.userId ?? undefined,
  topic: log.topic ?? undefined,
  type: log.type,
  title: log.title,
  body: log.body,
  imageUrl: log.imageUrl ?? undefined,
  route: log.route ?? undefined,
  data: (log.data ?? undefined) as Record<string, string> | undefined,
  silent: log.silent,
  pushLogId: log.id,
});

/** Deliver every SCHEDULED push whose time has come. The guarded updateMany
 *  (status must still be SCHEDULED) makes each row deliver exactly once even
 *  if a sweep overlaps a restart. */
const deliverDue = async (app: FastifyInstance): Promise<void> => {
  const due = await app.prisma.pushLog.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: 50,
  });

  for (const log of due) {
    const claimed = await app.prisma.pushLog.updateMany({
      where: { id: log.id, status: "SCHEDULED" },
      data: { status: "QUEUED" },
    });
    if (claimed.count === 0) continue;

    try {
      await dispatchNotification(app, jobFromPushLog(log));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      app.log.error({ err: error, pushLogId: log.id }, "scheduled push delivery failed");
      await app.prisma.pushLog
        .update({
          where: { id: log.id },
          data: { status: "FAILED", error: message.slice(0, 500) },
        })
        .catch(() => {});
    }
  }
};

/**
 * In-process scheduler for admin-scheduled pushes — replaces the BullMQ
 * delayed-job worker so the backend runs without Redis. Sweeps at boot
 * (catching up anything missed while the service was down) and then every
 * POLL_INTERVAL_MS. Returns a stop function for graceful shutdown.
 */
export const startScheduler = (app: FastifyInstance): (() => void) => {
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) return; // a slow sweep must not overlap the next tick
    running = true;
    try {
      await deliverDue(app);
    } catch (error) {
      app.log.error({ err: error }, "scheduled-push sweep failed");
    } finally {
      running = false;
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), POLL_INTERVAL_MS);
  timer.unref(); // never keep the process alive on its own

  app.log.info("in-process push scheduler started (Redis-free)");
  return () => clearInterval(timer);
};

/** Authoritative Ludo timeout/reconnect/queue sweeps plus socket heartbeat
 * eviction. Both timers are stopped by the server shutdown path. */
export const startLudoRuntime = (app: FastifyInstance): (() => void) => {
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await app.di.ludoService.sweep();
    } catch (error) {
      app.log.error({ err: error, component: "ludo-sweeper" }, "ludo sweep failed");
    } finally {
      running = false;
    }
  };
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), 3_000);
  sweepTimer.unref();
  const heartbeatTimer = setInterval(() => {
    const staleUserIds = app.di.ludoHub.closeStale(Date.now() - 45_000);
    if (staleUserIds.length > 0) {
      app.log.info({ staleConnections: staleUserIds.length }, "closed stale ludo sockets");
    }
  }, 15_000);
  heartbeatTimer.unref();
  app.log.info({ component: "ludo-runtime" }, "ludo realtime workers started");
  return () => {
    clearInterval(sweepTimer);
    clearInterval(heartbeatTimer);
  };
};
