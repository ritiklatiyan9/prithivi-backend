import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  RouletteProbabilityProfile,
  RouletteProbabilitySchedule,
  RouletteRound,
} from "@prisma/client";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../common/errors.js";
import type { PageMeta } from "../../../common/response.js";
import type { NotificationsService } from "../../notifications/services/notifications.service.js";
import type { SettingsService } from "../../settings/services/settings.service.js";
import {
  probabilityModeForProfile,
  probabilityScheduleStatusAt,
} from "../engine/probability-policy.js";
import {
  RED_NUMBERS,
  WHEEL_SEQUENCE,
  colourOf,
  deriveOutcome,
  estimateRtp,
  evaluatePayoutCapacity,
  hashSeed,
  newSeed,
  parityOf,
  settleBet,
  validateWeights,
  type PayoutCapacity,
  type PayoutMultipliers,
  type ProbabilityMode,
  type RouletteBetType,
} from "../engine/roulette.js";
import type {
  CancelProbabilityScheduleInput,
  CreateProbabilityScheduleInput,
  CreateProfileInput,
  CurrentProbabilityPolicyDto,
  EstimateRtpInput,
  PlayInput,
  PlayResultDto,
  ProbabilityProfileDto,
  ProbabilityScheduleDto,
  RouletteAnalyticsDto,
  RouletteConfigDto,
  RouletteRoundDto,
  RouletteStatusDto,
  RoundsQuery,
  RtpEstimateDto,
  VerifyRoundDto,
} from "../schemas/roulette.schema.js";

/** Actor identity threaded from the controller for audit entries. */
export interface AdminActor {
  id: string;
  email?: string;
  ip?: string;
  userAgent?: string;
}

const num = (d: Prisma.Decimal | number | null | undefined): number =>
  d === null || d === undefined ? 0 : typeof d === "number" ? d : d.toNumber();

type ProbabilityScheduleWithProfile = RouletteProbabilitySchedule & {
  profile: RouletteProbabilityProfile;
};

type ProbabilityPolicyClient = Pick<PrismaClient, "rouletteProbabilitySchedule">;
type RouletteRoundReadClient = Pick<PrismaClient, "rouletteRound">;

interface ResolvedProbabilityPolicy {
  source: "FAIR" | "SCHEDULE";
  mode: ProbabilityMode;
  schedule: ProbabilityScheduleWithProfile | null;
  weights: number[] | null;
  estimatedRtp: number;
  resolvedAt: Date;
  nextTransitionAt: Date | null;
}

// ponytail: queries are direct-Prisma like GameService; add a repository only if they grow.
export class RouletteService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---- config / settings helpers ----

  private async payoutMultipliers(): Promise<PayoutMultipliers> {
    const [number, odd, even, red, black] = await Promise.all([
      this.settings.getNumber("game.roulette.payout.number"),
      this.settings.getNumber("game.roulette.payout.odd"),
      this.settings.getNumber("game.roulette.payout.even"),
      this.settings.getNumber("game.roulette.payout.red"),
      this.settings.getNumber("game.roulette.payout.black"),
    ]);
    return { number, odd, even, red, black };
  }

  private async betTypeEnabled(betType: RouletteBetType): Promise<boolean> {
    const key = {
      NUMBER: "game.roulette.bet.numberEnabled",
      ODD: "game.roulette.bet.oddEnabled",
      EVEN: "game.roulette.bet.evenEnabled",
      RED: "game.roulette.bet.redEnabled",
      BLACK: "game.roulette.bet.blackEnabled",
    }[betType];
    return this.settings.getBoolean(key);
  }

  private async transactionNow(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<{ now: Date }[]>`
      SELECT clock_timestamp() AS "now"`;
    const now = rows[0]?.now;
    if (!now)
      throw new AppError("Could not resolve database time", 503, "DATABASE_TIME_UNAVAILABLE");
    return now;
  }

  /** Serialize all plays for one user; hash collisions only add harmless extra serialization. */
  private async lockUserPlay(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    // $executeRaw, not $queryRaw: the lock functions return SQL `void`, which
    // Prisma's row deserializer rejects (P2010).
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 20260724))`;
  }

  /**
   * Live policy reads share a dedicated lock; schedule mutations take the
   * matching exclusive lock. This makes DB time + schedule selection one
   * linearizable snapshot without serializing unrelated plays.
   */
  private async lockProbabilityPolicyRead(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock_shared(20260724, 7301)`;
  }

  private async lockProbabilityPolicyWrite(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(20260724, 7301)`;
  }

  private profileWeights(profile: Pick<RouletteProbabilityProfile, "mode" | "numberWeights">): {
    mode: ProbabilityMode;
    weights: number[] | null;
  } {
    const profileMode = profile.mode as ProbabilityMode;
    const mode = probabilityModeForProfile(profileMode);
    if (mode === "FAIR") return { mode, weights: null };

    const check = validateWeights(profile.numberWeights);
    if (!check.valid) {
      throw new AppError(
        "The scheduled roulette probability profile is invalid",
        503,
        "ROULETTE_POLICY_INVALID",
        check.errors,
      );
    }
    return { mode, weights: profile.numberWeights as number[] };
  }

  /**
   * Resolve exactly one policy at a DB-clock instant. Schedules are immutable;
   * cancellation is considered relative to the same instant so a boundary or
   * concurrent cancellation cannot change a spin after it has been accepted.
   */
  private async resolveProbabilityPolicy(
    payouts: PayoutMultipliers,
  ): Promise<ResolvedProbabilityPolicy> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockProbabilityPolicyRead(tx);
        const resolvedAt = await this.transactionNow(tx);
        return this.resolveProbabilityPolicyAt(tx, payouts, resolvedAt);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async resolveProbabilityPolicyAt(
    client: ProbabilityPolicyClient,
    payouts: PayoutMultipliers,
    resolvedAt: Date,
  ): Promise<ResolvedProbabilityPolicy> {
    const validAtInstant: Prisma.RouletteProbabilityScheduleWhereInput = {
      createdAt: { lte: resolvedAt },
      startsAt: { lte: resolvedAt },
      endsAt: { gt: resolvedAt },
      OR: [{ cancelledAt: null }, { cancelledAt: { gt: resolvedAt } }],
    };
    const futureAtInstant: Prisma.RouletteProbabilityScheduleWhereInput = {
      createdAt: { lte: resolvedAt },
      startsAt: { gt: resolvedAt },
      OR: [{ cancelledAt: null }, { cancelledAt: { gt: resolvedAt } }],
    };

    const [schedule, nextSchedule] = await Promise.all([
      client.rouletteProbabilitySchedule.findFirst({
        where: validAtInstant,
        include: { profile: true },
        orderBy: { startsAt: "desc" },
      }),
      client.rouletteProbabilitySchedule.findFirst({
        where: futureAtInstant,
        select: { startsAt: true },
        orderBy: { startsAt: "asc" },
      }),
    ]);

    if (!schedule) {
      const estimatedRtp = estimateRtp("FAIR", null, payouts).overall;
      return {
        source: "FAIR",
        mode: "FAIR",
        schedule: null,
        weights: null,
        estimatedRtp: Number(estimatedRtp.toFixed(4)),
        resolvedAt,
        nextTransitionAt: nextSchedule?.startsAt ?? null,
      };
    }

    const { mode, weights } = this.profileWeights(schedule.profile);
    const estimatedRtp = estimateRtp(mode, weights, payouts).overall;
    return {
      source: "SCHEDULE",
      mode,
      schedule,
      weights,
      estimatedRtp: Number(estimatedRtp.toFixed(4)),
      resolvedAt,
      nextTransitionAt: schedule.endsAt,
    };
  }

  private async startOfDay(): Promise<Date> {
    const tz = await this.settings.getString("game.roulette.resetTimezone");
    return this.prisma.$transaction(async (tx) => {
      const now = await this.transactionNow(tx);
      return this.transactionDayStart(tx, now, tz);
    });
  }

  /**
   * Resolve the configured timezone's midnight in PostgreSQL. This avoids an
   * application/server clock split and remains exact on DST transition days.
   */
  private async transactionDayStart(
    tx: Prisma.TransactionClient,
    now: Date,
    timezone: string,
  ): Promise<Date> {
    const rows = await tx.$queryRaw<{ startOfDay: Date }[]>`
      SELECT (
        date_trunc('day', ${now}::timestamptz AT TIME ZONE ${timezone})
        AT TIME ZONE ${timezone}
      ) AS "startOfDay"`;
    const startOfDay = rows[0]?.startOfDay;
    if (!startOfDay) {
      throw new AppError(
        "Could not resolve the roulette daily reset boundary",
        503,
        "ROULETTE_DAY_BOUNDARY_UNAVAILABLE",
      );
    }
    return startOfDay;
  }

  private async dailyUsage(
    userId: string,
    startOfDay: Date,
    client: RouletteRoundReadClient = this.prisma,
  ): Promise<{ total: number; paid: number; freeUsed: number; credited: number }> {
    const rows = await client.rouletteRound.findMany({
      where: { userId, createdAt: { gte: startOfDay }, status: "SETTLED" },
      select: { usedFreeGame: true, payoutAmount: true },
    });
    let paid = 0;
    let freeUsed = 0;
    let credited = 0;
    for (const r of rows) {
      if (r.usedFreeGame) freeUsed += 1;
      else paid += 1;
      credited += num(r.payoutAmount);
    }
    return { total: rows.length, paid, freeUsed, credited };
  }

  async getStatus(userId: string): Promise<RouletteStatusDto> {
    const startOfDay = await this.startOfDay();
    const [
      enabled,
      maintenance,
      freeEnabled,
      freePerDay,
      freeStake,
      maxGames,
      maxPaid,
      cooldownS,
      maxPayoutDay,
    ] = await Promise.all([
      this.settings.getBoolean("game.roulette.enabled"),
      this.settings.getBoolean("game.roulette.maintenanceMode"),
      this.settings.getBoolean("game.roulette.freeGamesEnabled"),
      this.settings.getNumber("game.roulette.dailyFreeGames"),
      this.settings.getNumber("game.roulette.freeGameStake"),
      this.settings.getNumber("game.roulette.maxGamesPerDay"),
      this.settings.getNumber("game.roulette.maxPaidGamesPerDay"),
      this.settings.getNumber("game.roulette.cooldownSeconds"),
      this.settings.getNumber("game.roulette.maxPayoutPerUserPerDay"),
    ]);

    const [usage, wallet, lastRound] = await Promise.all([
      this.dailyUsage(userId, startOfDay),
      this.prisma.wallet.findUnique({ where: { userId } }),
      this.prisma.rouletteRound.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    const cooldownRemainingMs = lastRound
      ? Math.max(0, lastRound.createdAt.getTime() + cooldownS * 1000 - Date.now())
      : 0;

    return {
      walletBalance: wallet ? num(wallet.balance) : 0,
      freeGamesEnabled: freeEnabled,
      freeGamesPerDay: freePerDay,
      freeGamesRemaining: freeEnabled ? Math.max(0, freePerDay - usage.freeUsed) : 0,
      freeGameStake: freeStake,
      totalPlayedToday: usage.total,
      paidPlayedToday: usage.paid,
      maxGamesPerDay: maxGames,
      maxPaidGamesPerDay: maxPaid,
      dailyPayoutRemaining: Math.max(0, maxPayoutDay - usage.credited),
      cooldownRemainingMs,
      canPlay: enabled && !maintenance && usage.total < maxGames && cooldownRemainingMs <= 0,
    };
  }

  async getConfig(userId: string): Promise<RouletteConfigDto> {
    const [
      enabled,
      maintenance,
      title,
      subtitle,
      instructions,
      minBet,
      maxBet,
      defaultBet,
      betStep,
      animationDurationMs,
      resultModalMs,
      cooldownSeconds,
      soundEnabled,
      hapticsEnabled,
      maxPayoutPerGame,
      payouts,
      betNumber,
      betOdd,
      betEven,
      betRed,
      betBlack,
      status,
    ] = await Promise.all([
      this.settings.getBoolean("game.roulette.enabled"),
      this.settings.getBoolean("game.roulette.maintenanceMode"),
      this.settings.getString("game.roulette.title"),
      this.settings.getString("game.roulette.subtitle"),
      this.settings.getString("game.roulette.instructions"),
      this.settings.getNumber("game.roulette.minBet"),
      this.settings.getNumber("game.roulette.maxBet"),
      this.settings.getNumber("game.roulette.defaultBet"),
      this.settings.getNumber("game.roulette.betStep"),
      this.settings.getNumber("game.roulette.animationDurationMs"),
      this.settings.getNumber("game.roulette.resultModalMs"),
      this.settings.getNumber("game.roulette.cooldownSeconds"),
      this.settings.getBoolean("game.roulette.soundEnabled"),
      this.settings.getBoolean("game.roulette.hapticsEnabled"),
      this.settings.getNumber("game.roulette.maxPayoutPerGame"),
      this.payoutMultipliers(),
      this.settings.getBoolean("game.roulette.bet.numberEnabled"),
      this.settings.getBoolean("game.roulette.bet.oddEnabled"),
      this.settings.getBoolean("game.roulette.bet.evenEnabled"),
      this.settings.getBoolean("game.roulette.bet.redEnabled"),
      this.settings.getBoolean("game.roulette.bet.blackEnabled"),
      this.getStatus(userId),
    ]);

    const policy = await this.resolveProbabilityPolicy(payouts);

    return {
      enabled,
      maintenanceMode: maintenance,
      title,
      subtitle,
      instructions,
      minBet,
      maxBet,
      defaultBet,
      betStep,
      animationDurationMs,
      resultModalMs,
      cooldownSeconds,
      soundEnabled,
      hapticsEnabled,
      probabilityMode: policy.mode,
      estimatedRtp: policy.estimatedRtp,
      payouts,
      betTypesEnabled: {
        number: betNumber,
        odd: betOdd,
        even: betEven,
        red: betRed,
        black: betBlack,
      },
      wheelSequence: [...WHEEL_SEQUENCE],
      redNumbers: [...RED_NUMBERS],
      maxPayoutPerGame,
      status,
    };
  }

  // ---- play (atomic bet + settle + wallet) ----

  async play(userId: string, input: PlayInput): Promise<PlayResultDto> {
    // Fast path for a duplicate tap / network retry: same key => same round.
    const prior = await this.prisma.rouletteRound.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
    });
    if (prior) return this.buildPlayResult(prior, userId);

    const betType = input.betType as RouletteBetType;
    const [
      enabled,
      maintenance,
      freeEnabled,
      minBet,
      maxBet,
      maxPayoutGame,
      maxPayoutDay,
      maxGames,
      maxPaid,
      cooldownS,
      freePerDay,
      freeStake,
      resetTimezone,
      betEnabled,
      payouts,
    ] = await Promise.all([
      this.settings.getBoolean("game.roulette.enabled"),
      this.settings.getBoolean("game.roulette.maintenanceMode"),
      this.settings.getBoolean("game.roulette.freeGamesEnabled"),
      this.settings.getNumber("game.roulette.minBet"),
      this.settings.getNumber("game.roulette.maxBet"),
      this.settings.getNumber("game.roulette.maxPayoutPerGame"),
      this.settings.getNumber("game.roulette.maxPayoutPerUserPerDay"),
      this.settings.getNumber("game.roulette.maxGamesPerDay"),
      this.settings.getNumber("game.roulette.maxPaidGamesPerDay"),
      this.settings.getNumber("game.roulette.cooldownSeconds"),
      this.settings.getNumber("game.roulette.dailyFreeGames"),
      this.settings.getNumber("game.roulette.freeGameStake"),
      this.settings.getString("game.roulette.resetTimezone"),
      this.betTypeEnabled(betType),
      this.payoutMultipliers(),
    ]);

    if (!enabled) throw new ForbiddenError("Roulette is currently disabled");
    if (maintenance)
      throw new ForbiddenError("Roulette is under maintenance. Please try again soon.");
    if (!betEnabled) {
      throw new BadRequestError("This bet type is currently disabled");
    }
    const selectedNumber = betType === "NUMBER" ? (input.selectedValue ?? null) : null;
    if (
      betType === "NUMBER" &&
      (selectedNumber === null || selectedNumber < 0 || selectedNumber > 36)
    ) {
      throw new BadRequestError("Pick a number from 0 to 36");
    }

    // Effective stake: free spins use the server-set notional stake; no debit.
    const useFree = input.useFreeGame === true;
    let stake: number;
    if (useFree) {
      if (!freeEnabled) throw new BadRequestError("Free games are disabled");
      stake = freeStake;
    } else {
      stake = input.betAmount;
      if (stake < minBet) throw new BadRequestError(`Minimum bet is ${minBet} coins`);
      if (stake > maxBet) throw new BadRequestError(`Maximum bet is ${maxBet} coins`);
    }
    if (stake <= 0) {
      throw new BadRequestError("Roulette stake must be greater than zero");
    }

    let round: RouletteRound;
    let createdNewRound = false;
    try {
      const settled = await this.prisma.$transaction(
        async (tx) => {
          // Different idempotency keys for the same user must still serialize:
          // limits, payout allowance, outcome and wallet settlement are one decision.
          await this.lockUserPlay(tx, userId);

          const duplicate = await tx.rouletteRound.findUnique({
            where: {
              userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey },
            },
          });
          if (duplicate) return { round: duplicate, created: false };

          // Shared policy lock linearizes this round against schedule create/cancel.
          await this.lockProbabilityPolicyRead(tx);
          const now = await this.transactionNow(tx);
          const startOfDay = await this.transactionDayStart(tx, now, resetTimezone);
          const [usage, lastRound] = await Promise.all([
            this.dailyUsage(userId, startOfDay, tx),
            tx.rouletteRound.findFirst({
              where: { userId },
              orderBy: { createdAt: "desc" },
              select: { createdAt: true },
            }),
          ]);

          if (usage.total >= maxGames) throw conflict("You've reached today's game limit");
          if (useFree && usage.freeUsed >= freePerDay) {
            throw conflict("No free games remaining today");
          }
          if (!useFree && usage.paid >= maxPaid) {
            throw conflict("You've reached today's paid-game limit");
          }
          if (cooldownS > 0 && lastRound) {
            const waitMs = lastRound.createdAt.getTime() + cooldownS * 1000 - now.getTime();
            if (waitMs > 0) {
              throw conflict(`Please wait ${Math.ceil(waitMs / 1000)}s before your next spin`);
            }
          }

          const dailyAllowance = Math.max(0, maxPayoutDay - usage.credited);
          const capacity = evaluatePayoutCapacity({
            betType,
            stake,
            multipliers: payouts,
            maxPayoutPerGame: maxPayoutGame,
            dailyPayoutRemaining: dailyAllowance,
          });
          if (!capacity.eligible) {
            throw payoutCapacityError(capacity, maxPayoutGame, dailyAllowance);
          }

          // Capacity is decided before sampling: accepted rounds are full wins or
          // true losses, never partially paid or forced to a losing pocket.
          const policy = await this.resolveProbabilityPolicyAt(tx, payouts, now);
          const { mode, weights } = policy;
          const serverSeed = newSeed();
          const serverSeedHash = hashSeed(serverSeed);
          const clientSeed = input.clientSeed ?? newSeed();
          const nonce = 0; // fresh server seed per round
          const { winningNumber } = deriveOutcome({
            serverSeed,
            clientSeed,
            nonce,
            mode,
            weights,
          });
          const outcome = settleBet({
            betType,
            selectedNumber,
            stake,
            winningNumber,
            multipliers: payouts,
          });
          const payout = outcome.payout;
          const netResult = useFree ? payout : payout - stake;

          const configSnapshot = {
            payouts,
            minBet,
            maxBet,
            probabilitySource: policy.source,
            probabilityMode: mode,
            probabilityProfileId: policy.schedule?.profile.id ?? null,
            probabilityProfileName: policy.schedule?.profile.name ?? null,
            probabilityScheduleId: policy.schedule?.id ?? null,
            probabilityScheduleStartsAt: policy.schedule?.startsAt.toISOString() ?? null,
            probabilityScheduleEndsAt: policy.schedule?.endsAt.toISOString() ?? null,
            policyResolvedAt: policy.resolvedAt.toISOString(),
            weights: weights ?? undefined,
            fullWinPayout: capacity.fullPayout,
            maxPayoutPerGame: maxPayoutGame,
            maxPayoutPerUserPerDay: maxPayoutDay,
            dailyPayoutRemainingBeforeRound: dailyAllowance,
            freeGameStake: useFree ? stake : undefined,
          };
          const stakeDec = new Prisma.Decimal(stake);
          const payoutDec = new Prisma.Decimal(payout);

          const created = await tx.rouletteRound.create({
            data: {
              userId,
              betType,
              selectedNumber,
              betAmount: stakeDec,
              usedFreeGame: useFree,
              winningNumber,
              winningColour: outcome.colour,
              parity: outcome.parity,
              won: outcome.won,
              payoutMultiplier: outcome.profitMultiplier,
              payoutAmount: payoutDec,
              netResult: new Prisma.Decimal(netResult),
              status: "SETTLED",
              probabilityMode: mode,
              configSnapshot: configSnapshot as unknown as Prisma.InputJsonValue,
              probabilityProfileId: policy.schedule?.profile.id ?? null,
              probabilityScheduleId: policy.schedule?.id ?? null,
              policyResolvedAt: policy.resolvedAt,
              serverSeed,
              serverSeedHash,
              clientSeed,
              nonce,
              idempotencyKey: input.idempotencyKey,
              // Explicit DB-clock time is essential after waiting on the
              // per-user lock: PostgreSQL's default now() is the transaction
              // start, which may belong to the previous daily window.
              createdAt: now,
              settledAt: now,
            },
          });

          const wallet = await tx.wallet.upsert({
            where: { userId },
            create: { userId },
            update: {},
          });

          // Paid: atomic guarded debit — the balance condition is what makes a
          // negative balance / double-spend impossible without an explicit lock.
          if (!useFree) {
            const debit = await tx.wallet.updateMany({
              where: { id: wallet.id, balance: { gte: stakeDec } },
              data: { balance: { decrement: stakeDec } },
            });
            if (debit.count !== 1) {
              throw new AppError("Insufficient coin balance", 400, "INSUFFICIENT_BALANCE");
            }
            const afterDebit = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
            await tx.walletTransaction.create({
              data: {
                walletId: wallet.id,
                type: "DEBIT",
                amount: stakeDec,
                balanceAfter: afterDebit.balance,
                reference: `game-roulette-bet:${created.id}`,
                description: `Roulette bet (${betType.toLowerCase()})`,
                createdAt: now,
              },
            });
          }

          // Credit the payout on a win (single CREDIT row per round).
          if (payout > 0) {
            const afterCredit = await tx.wallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: payoutDec } },
            });
            await tx.walletTransaction.create({
              data: {
                walletId: wallet.id,
                type: "CREDIT",
                amount: payoutDec,
                balanceAfter: afterCredit.balance,
                reference: `game-roulette:${created.id}`,
                description: `Roulette win — pocket ${winningNumber}`,
                createdAt: now,
              },
            });
          }

          return { round: created, created: true };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 10_000,
        },
      );
      round = settled.round;
      createdNewRound = settled.created;
    } catch (error) {
      // A concurrent duplicate lost the unique-key race — return the winner.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await this.prisma.rouletteRound.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
        });
        if (existing) return this.buildPlayResult(existing, userId);
      }
      throw error;
    }

    if (createdNewRound && round.won && num(round.payoutAmount) > 0) {
      // Fire-and-forget; delivery failure never blocks the response.
      void this.notifications.enqueue({
        userId,
        type: "WALLET",
        title: "Roulette win!",
        body: `Pocket ${round.winningNumber} — you won ${num(round.payoutAmount)} coins.`,
      });
    }

    return this.buildPlayResult(round, userId);
  }

  private async buildPlayResult(round: RouletteRound, userId: string): Promise<PlayResultDto> {
    const [status, animationDurationMs] = await Promise.all([
      this.getStatus(userId),
      this.settings.getNumber("game.roulette.animationDurationMs"),
    ]);
    const dto = this.toPlayResult(round, status);
    dto.animationDurationMs = animationDurationMs;
    return dto;
  }

  // ---- history / recent / verify ----

  async history(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ items: RouletteRoundDto[]; meta: PageMeta }> {
    const [rows, total] = await Promise.all([
      this.prisma.rouletteRound.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.rouletteRound.count({ where: { userId } }),
    ]);
    return {
      items: rows.map((r) => this.toRoundDto(r, false)),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  async recentResults(take = 15): Promise<{ winningNumber: number; colour: string }[]> {
    const rows = await this.prisma.rouletteRound.findMany({
      where: { status: "SETTLED" },
      orderBy: { createdAt: "desc" },
      take,
      select: { winningNumber: true, winningColour: true },
    });
    return rows.map((r) => ({ winningNumber: r.winningNumber, colour: r.winningColour }));
  }

  async verifyRound(roundId: string, userId?: string): Promise<VerifyRoundDto> {
    const round = await this.prisma.rouletteRound.findUnique({ where: { id: roundId } });
    if (!round || (userId && round.userId !== userId)) throw new NotFoundError("Round not found");

    const snapshot = (round.configSnapshot ?? {}) as { weights?: number[] };
    const mode = round.probabilityMode as ProbabilityMode;
    const weights = mode === "WEIGHTED" ? (snapshot.weights ?? null) : null;
    const { winningNumber } = deriveOutcome({
      serverSeed: round.serverSeed,
      clientSeed: round.clientSeed,
      nonce: round.nonce,
      mode,
      weights,
    });

    return {
      roundId: round.id,
      serverSeed: round.serverSeed,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      nonce: round.nonce,
      probabilityMode: round.probabilityMode,
      probabilityScheduleId: round.probabilityScheduleId,
      policyResolvedAt: round.policyResolvedAt.toISOString(),
      weights: weights ?? null,
      recordedWinningNumber: round.winningNumber,
      computedWinningNumber: winningNumber,
      hashMatches: hashSeed(round.serverSeed) === round.serverSeedHash,
      outcomeMatches: winningNumber === round.winningNumber,
    };
  }

  // ---- admin: probability profiles ----

  async listProfiles(): Promise<ProbabilityProfileDto[]> {
    const [rows, payouts] = await Promise.all([
      this.prisma.rouletteProbabilityProfile.findMany({
        orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      }),
      this.payoutMultipliers(),
    ]);
    return rows.map((profile) => {
      const dto = this.toProfileDto(profile);
      const { mode, weights } = this.profileWeights(profile);
      dto.estimatedRtp = Number(estimateRtp(mode, weights, payouts).overall.toFixed(4));
      return dto;
    });
  }

  async listProbabilitySchedules(): Promise<ProbabilityScheduleDto[]> {
    const payouts = await this.payoutMultipliers();
    const { rows, now } = await this.prisma.$transaction(
      async (tx) => {
        await this.lockProbabilityPolicyRead(tx);
        const now = await this.transactionNow(tx);
        const rows = await tx.rouletteProbabilitySchedule.findMany({
          include: { profile: true },
          orderBy: { startsAt: "desc" },
        });
        return { rows, now };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    return rows.map((row) => this.toProbabilityScheduleDto(row, now, payouts));
  }

  async createProbabilitySchedule(
    actor: AdminActor,
    input: CreateProbabilityScheduleInput,
  ): Promise<ProbabilityScheduleDto> {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(endsAt.getTime()) ||
      startsAt.getTime() >= endsAt.getTime()
    ) {
      throw new BadRequestError("endsAt must be later than startsAt");
    }
    const payouts = await this.payoutMultipliers();

    try {
      const { schedule, now } = await this.prisma.$transaction(
        async (tx) => {
          await this.lockProbabilityPolicyWrite(tx);
          const now = await this.transactionNow(tx);
          if (endsAt.getTime() <= now.getTime()) {
            throw new BadRequestError("A probability schedule must end in the future");
          }
          // "Start now" requests inevitably arrive a little late. Canonicalize
          // any past start to the locked DB instant so declared/effective windows match.
          const effectiveStartsAt = startsAt.getTime() < now.getTime() ? now : startsAt;

          const profile = await tx.rouletteProbabilityProfile.findUnique({
            where: { id: input.profileId },
          });
          if (!profile) throw new NotFoundError("Probability profile not found");

          const { mode, weights } = this.profileWeights(profile);
          const rtp = estimateRtp(mode, weights, payouts).overall;
          const overlap = await tx.rouletteProbabilitySchedule.findFirst({
            where: {
              cancelledAt: null,
              startsAt: { lt: endsAt },
              endsAt: { gt: effectiveStartsAt },
            },
            select: { id: true, startsAt: true, endsAt: true },
            orderBy: { startsAt: "asc" },
          });
          if (overlap) throw probabilityScheduleOverlap(overlap);

          const schedule = await tx.rouletteProbabilitySchedule.create({
            data: {
              profileId: profile.id,
              startsAt: effectiveStartsAt,
              endsAt,
              reason: input.reason.trim(),
              createdById: actor.id,
            },
            include: { profile: true },
          });

          await this.writeScheduleAudit(
            tx,
            actor,
            "ROULETTE_SCHEDULE_CREATE",
            schedule.id,
            null,
            {
              profileId: profile.id,
              profileName: profile.name,
              mode,
              numberWeights: weights,
              estimatedRtp: Number(rtp.toFixed(4)),
              startsAt: effectiveStartsAt.toISOString(),
              endsAt: endsAt.toISOString(),
              reason: schedule.reason,
            },
            201,
          );

          return { schedule, now };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );

      return this.toProbabilityScheduleDto(schedule, now, payouts);
    } catch (error) {
      // PostgreSQL's exclusion constraint is the authoritative race-safe guard.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2004") {
        throw probabilityScheduleOverlap();
      }
      throw error;
    }
  }

  async cancelProbabilitySchedule(
    actor: AdminActor,
    id: string,
    input: CancelProbabilityScheduleInput,
  ): Promise<ProbabilityScheduleDto> {
    const payouts = await this.payoutMultipliers();
    const { schedule, now } = await this.prisma.$transaction(
      async (tx) => {
        await this.lockProbabilityPolicyWrite(tx);
        const now = await this.transactionNow(tx);
        const current = await tx.rouletteProbabilitySchedule.findUnique({
          where: { id },
          include: { profile: true },
        });
        if (!current) throw new NotFoundError("Probability schedule not found");
        if (current.cancelledAt)
          throw new ConflictError("Probability schedule is already cancelled");
        if (current.endsAt.getTime() <= now.getTime()) {
          throw new ConflictError("An expired probability schedule cannot be cancelled");
        }

        const updated = await tx.rouletteProbabilitySchedule.updateMany({
          where: { id, cancelledAt: null },
          data: {
            cancelledAt: now,
            cancelledById: actor.id,
            cancelReason: input.reason.trim(),
          },
        });
        if (updated.count !== 1) {
          throw new ConflictError("Probability schedule was cancelled by another request");
        }

        const schedule = await tx.rouletteProbabilitySchedule.findUniqueOrThrow({
          where: { id },
          include: { profile: true },
        });
        await this.writeScheduleAudit(
          tx,
          actor,
          "ROULETTE_SCHEDULE_CANCEL",
          schedule.id,
          {
            cancelledAt: null,
            cancelReason: null,
            startsAt: current.startsAt.toISOString(),
            endsAt: current.endsAt.toISOString(),
            profileId: current.profileId,
          },
          {
            cancelledAt: now.toISOString(),
            cancelReason: schedule.cancelReason,
            reason: schedule.cancelReason,
          },
          200,
        );
        return { schedule, now };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    return this.toProbabilityScheduleDto(schedule, now, payouts);
  }

  async currentProbabilityPolicy(): Promise<CurrentProbabilityPolicyDto> {
    const payouts = await this.payoutMultipliers();
    const policy = await this.resolveProbabilityPolicy(payouts);
    return {
      source: policy.source,
      mode: policy.mode,
      scheduleId: policy.schedule?.id ?? null,
      profileId: policy.schedule?.profileId ?? null,
      profileName: policy.schedule?.profile.name ?? null,
      estimatedRtp: policy.estimatedRtp,
      startsAt: policy.schedule?.startsAt.toISOString() ?? null,
      endsAt: policy.schedule?.endsAt.toISOString() ?? null,
      nextTransitionAt: policy.nextTransitionAt?.toISOString() ?? null,
    };
  }

  async createProfile(
    actor: AdminActor,
    input: CreateProfileInput,
  ): Promise<ProbabilityProfileDto> {
    const mode: ProbabilityMode = input.mode;
    let weights: number[] = Array.from({ length: 37 }, () => 1); // FAIR default
    if (mode === "WEIGHTED") {
      const check = validateWeights(input.numberWeights);
      if (!check.valid) throw new BadRequestError("Invalid weights", check.errors);
      weights = input.numberWeights as number[];
    }
    const payouts = await this.payoutMultipliers();
    const rtp = estimateRtp(mode, weights, payouts).overall;

    const created = await this.prisma.$transaction(async (tx) => {
      const profile = await tx.rouletteProbabilityProfile.create({
        data: {
          name: input.name.trim(),
          mode,
          numberWeights: weights as unknown as Prisma.InputJsonValue,
          estimatedRtp: new Prisma.Decimal(rtp.toFixed(4)),
          active: false,
          createdById: actor.id,
        },
      });
      await this.writeProfileAudit(tx, actor, "ROULETTE_PROFILE_CREATE", profile.id, null, {
        name: profile.name,
        mode,
        numberWeights: weights,
        estimatedRtp: Number(rtp.toFixed(4)),
        reason: input.reason?.trim() || null,
      });
      return profile;
    });

    return this.toProfileDto(created);
  }

  async activateProfile(
    _actor: AdminActor,
    _id: string,
    _reason: string,
  ): Promise<ProbabilityProfileDto> {
    throw new AppError(
      "Immediate probability-profile activation is retired. Create a timed probability schedule.",
      410,
      "ROULETTE_PROFILE_ACTIVATION_RETIRED",
    );
  }

  async previewRtp(input: EstimateRtpInput): Promise<RtpEstimateDto> {
    const payouts = await this.payoutMultipliers();
    const warnings: string[] = [];
    let weights: number[] | null = null;
    if (input.mode === "WEIGHTED") {
      const check = validateWeights(input.numberWeights);
      if (!check.valid) throw new BadRequestError("Invalid weights", check.errors);
      weights = input.numberWeights as number[];
    }
    const est = estimateRtp(input.mode, weights, payouts);
    if (est.overall > 1)
      warnings.push("Overall RTP exceeds 100% — the system pays out more than it takes.");
    if (est.byCategory.maxNumberRtp > 1) {
      warnings.push(
        "A single number's RTP exceeds 100% — a player betting only that number profits long-term.",
      );
    }
    return { ...est, warnings };
  }

  // ---- admin: rounds + analytics ----

  async listRounds(query: RoundsQuery): Promise<{ items: RouletteRoundDto[]; meta: PageMeta }> {
    const where: Prisma.RouletteRoundWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.betType ? { betType: query.betType } : {}),
      ...(query.winningNumber !== undefined ? { winningNumber: query.winningNumber } : {}),
      ...(query.won !== undefined ? { won: query.won } : {}),
      ...(query.usedFreeGame !== undefined ? { usedFreeGame: query.usedFreeGame } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.minAmount !== undefined || query.maxAmount !== undefined
        ? {
            betAmount: {
              ...(query.minAmount !== undefined
                ? { gte: new Prisma.Decimal(query.minAmount) }
                : {}),
              ...(query.maxAmount !== undefined
                ? { lte: new Prisma.Decimal(query.maxAmount) }
                : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.rouletteRound.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.rouletteRound.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toRoundDto(r, false)),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  }

  async getRound(id: string): Promise<RouletteRoundDto> {
    const round = await this.prisma.rouletteRound.findUnique({ where: { id } });
    if (!round) throw new NotFoundError("Round not found");
    return this.toRoundDto(round, true);
  }

  /**
   * Analytics over a date window (defaults to the last 30 days). Aggregated in
   * memory from one range fetch — fine for virtual-coin volumes.
   * ponytail: move to SQL rollups if the round table ever gets huge.
   */
  async analytics(from?: string, to?: string): Promise<RouletteAnalyticsDto> {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();
    const where: Prisma.RouletteRoundWhereInput = {
      createdAt: { gte: fromDate, lte: toDate },
      status: "SETTLED",
    };

    // Everything aggregates inside Postgres — no rounds are streamed into
    // memory — so this stays fast with millions of rounds / 100K+ users.
    const [
      totalAgg,
      paidAgg,
      lostAgg,
      winCount,
      playerRows,
      numberGroups,
      mostActiveGroups,
      topWinRows,
      recentRows,
      dailyRows,
    ] = await Promise.all([
      this.prisma.rouletteRound.aggregate({ where, _count: true, _sum: { payoutAmount: true } }),
      this.prisma.rouletteRound.aggregate({
        where: { ...where, usedFreeGame: false },
        _count: true,
        _sum: { betAmount: true },
      }),
      this.prisma.rouletteRound.aggregate({
        where: { ...where, usedFreeGame: false, won: false },
        _sum: { betAmount: true },
      }),
      this.prisma.rouletteRound.count({ where: { ...where, won: true } }),
      this.prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(DISTINCT "userId")::int AS count
        FROM "roulette_rounds"
        WHERE "createdAt" >= ${fromDate} AND "createdAt" <= ${toDate} AND "status" = 'SETTLED'`,
      this.prisma.rouletteRound.groupBy({ by: ["winningNumber"], where, _count: true }),
      this.prisma.rouletteRound.groupBy({
        by: ["userId"],
        where,
        _count: true,
        orderBy: { _count: { userId: "desc" } },
        take: 5,
      }),
      this.prisma.rouletteRound.findMany({
        where: { ...where, won: true },
        orderBy: { payoutAmount: "desc" },
        take: 10,
        select: {
          id: true,
          userId: true,
          payoutAmount: true,
          winningNumber: true,
          createdAt: true,
        },
      }),
      this.prisma.rouletteRound.findMany({ where, orderBy: { createdAt: "desc" }, take: 10 }),
      this.prisma.$queryRaw<{ date: string; games: number; wagered: number; won: number }[]>`
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS games,
               COALESCE(SUM(CASE WHEN "usedFreeGame" THEN 0 ELSE "betAmount" END), 0)::float AS wagered,
               COALESCE(SUM("payoutAmount"), 0)::float AS won
        FROM "roulette_rounds"
        WHERE "createdAt" >= ${fromDate} AND "createdAt" <= ${toDate} AND "status" = 'SETTLED'
        GROUP BY 1 ORDER BY 1`,
    ]);

    const games = totalAgg._count;
    const coinsWon = num(totalAgg._sum.payoutAmount);
    const paidGames = paidAgg._count;
    const coinsWagered = num(paidAgg._sum.betAmount);
    const coinsLost = num(lostAgg._sum.betAmount);
    const freeGames = games - paidGames;
    const players = Number(playerRows[0]?.count ?? 0);

    const numberCounts = new Array(37).fill(0) as number[];
    for (const g of numberGroups) numberCounts[g.winningNumber] = g._count;
    const numberDistribution = numberCounts.map((count, number) => ({ number, count }));
    const parityDistribution = numberCounts.reduce(
      (acc, count, n) => {
        if (n === 0) acc.zero += count;
        else if (n % 2 === 1) acc.odd += count;
        else acc.even += count;
        return acc;
      },
      { odd: 0, even: 0, zero: 0 },
    );
    const colourDistribution = numberCounts.reduce(
      (acc, count, n) => {
        const c = colourOf(n);
        if (c === "RED") acc.red += count;
        else if (c === "BLACK") acc.black += count;
        else acc.green += count;
        return acc;
      },
      { red: 0, black: 0, green: 0 },
    );

    return {
      totals: {
        games,
        players,
        activePlayers: players,
        coinsWagered,
        coinsWon,
        coinsLost,
        netCoinMovement: coinsWon - coinsWagered,
        averageBet: paidGames > 0 ? Math.round((coinsWagered / paidGames) * 100) / 100 : 0,
        winRate: games > 0 ? Math.round((winCount / games) * 10000) / 10000 : 0,
        rtp: coinsWagered > 0 ? Math.round((coinsWon / coinsWagered) * 10000) / 10000 : 0,
        freeGames,
        paidGames,
      },
      numberDistribution,
      parityDistribution,
      colourDistribution,
      daily: dailyRows.map((d) => ({
        date: d.date,
        games: Number(d.games),
        wagered: Number(d.wagered),
        won: Number(d.won),
      })),
      topWins: topWinRows.map((r) => ({
        roundId: r.id,
        userId: r.userId,
        payoutAmount: num(r.payoutAmount),
        winningNumber: r.winningNumber,
        createdAt: r.createdAt.toISOString(),
      })),
      mostActive: mostActiveGroups.map((g) => ({ userId: g.userId, games: g._count })),
      recentRounds: recentRows.map((r) => this.toRoundDto(r, false)),
    };
  }

  async auditLogs(page: number, limit: number): Promise<{ items: unknown[]; meta: PageMeta }> {
    const where: Prisma.AuditLogWhereInput = {
      OR: [{ action: { startsWith: "ROULETTE_" } }, { path: { contains: "roulette" } }],
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        adminId: r.userId,
        adminEmail: r.userEmail,
        action: r.action,
        method: r.method,
        path: r.path,
        statusCode: r.statusCode,
        ip: r.ip,
        userAgent: r.userAgent,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      })),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  // ---- mappers + audit ----

  private toPlayResult(round: RouletteRound, status: RouletteStatusDto): PlayResultDto {
    return {
      roundId: round.id,
      betType: round.betType as RouletteBetType,
      selectedNumber: round.selectedNumber,
      betAmount: num(round.betAmount),
      usedFreeGame: round.usedFreeGame,
      winningNumber: round.winningNumber,
      winningColour: colourOf(round.winningNumber),
      parity: parityOf(round.winningNumber),
      won: round.won,
      payoutMultiplier: round.payoutMultiplier,
      payoutAmount: num(round.payoutAmount),
      netResult: num(round.netResult),
      walletBalance: status.walletBalance,
      freeGamesRemaining: status.freeGamesRemaining,
      wheelIndex: WHEEL_SEQUENCE.indexOf(round.winningNumber),
      animationDurationMs: 0, // filled by the controller from settings
      fairness: {
        serverSeed: round.serverSeed,
        serverSeedHash: round.serverSeedHash,
        clientSeed: round.clientSeed,
        nonce: round.nonce,
      },
      status,
    };
  }

  private toRoundDto(round: RouletteRound, includeSeed: boolean): RouletteRoundDto {
    return {
      id: round.id,
      userId: round.userId,
      betType: round.betType as RouletteBetType,
      selectedNumber: round.selectedNumber,
      betAmount: num(round.betAmount),
      usedFreeGame: round.usedFreeGame,
      winningNumber: round.winningNumber,
      winningColour: round.winningColour,
      parity: round.parity,
      won: round.won,
      payoutMultiplier: round.payoutMultiplier,
      payoutAmount: num(round.payoutAmount),
      netResult: num(round.netResult),
      status: round.status,
      probabilityMode: round.probabilityMode,
      serverSeedHash: round.serverSeedHash,
      ...(includeSeed ? { serverSeed: round.serverSeed } : {}),
      clientSeed: round.clientSeed,
      nonce: round.nonce,
      probabilityProfileId: round.probabilityProfileId,
      probabilityScheduleId: round.probabilityScheduleId,
      policyResolvedAt: round.policyResolvedAt.toISOString(),
      createdAt: round.createdAt.toISOString(),
      settledAt: round.settledAt ? round.settledAt.toISOString() : null,
    };
  }

  private toProbabilityScheduleDto(
    schedule: ProbabilityScheduleWithProfile,
    now: Date,
    payouts: PayoutMultipliers,
  ): ProbabilityScheduleDto {
    const { mode, weights } = this.profileWeights(schedule.profile);
    const estimatedRtp = estimateRtp(mode, weights, payouts).overall;
    return {
      id: schedule.id,
      profileId: schedule.profileId,
      startsAt: schedule.startsAt.toISOString(),
      endsAt: schedule.endsAt.toISOString(),
      reason: schedule.reason,
      createdAt: schedule.createdAt.toISOString(),
      cancelledAt: schedule.cancelledAt?.toISOString() ?? null,
      cancelReason: schedule.cancelReason,
      status: probabilityScheduleStatusAt(schedule, now),
      profile: {
        id: schedule.profile.id,
        name: schedule.profile.name,
        mode,
        estimatedRtp: Number(estimatedRtp.toFixed(4)),
      },
    };
  }

  private toProfileDto(p: {
    id: string;
    name: string;
    mode: string;
    numberWeights: Prisma.JsonValue;
    estimatedRtp: Prisma.Decimal;
    active: boolean;
    effectiveFrom: Date;
    createdById: string | null;
    createdAt: Date;
  }): ProbabilityProfileDto {
    return {
      id: p.id,
      name: p.name,
      mode: p.mode,
      numberWeights: (p.numberWeights as number[]) ?? [],
      estimatedRtp: num(p.estimatedRtp),
      active: p.active,
      effectiveFrom: p.effectiveFrom.toISOString(),
      createdById: p.createdById,
      createdAt: p.createdAt.toISOString(),
    };
  }

  /**
   * Immutable audit entry for a probability/payout change: old value, new value,
   * reason, admin id + IP/UA — reusing the shared AuditLog table.
   */
  private async writeProfileAudit(
    tx: Prisma.TransactionClient,
    actor: AdminActor,
    action: string,
    entityId: string,
    oldValue: unknown,
    newValue: unknown,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        userId: actor.id,
        userEmail: actor.email ?? null,
        action,
        method: "POST",
        path: `roulette/profiles/${entityId}`,
        statusCode: 201,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: {
          entityType: "RouletteProbabilityProfile",
          entityId,
          oldValue,
          newValue,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** Rich schedule audits are part of the same transaction as the mutation. */
  private async writeScheduleAudit(
    tx: Prisma.TransactionClient,
    actor: AdminActor,
    action: string,
    entityId: string,
    oldValue: unknown,
    newValue: unknown,
    statusCode: number,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        userId: actor.id,
        userEmail: actor.email ?? null,
        action,
        method: "POST",
        path: `roulette/probability-schedules/${entityId}`,
        statusCode,
        ip: actor.ip ?? null,
        userAgent: actor.userAgent ?? null,
        metadata: {
          entityType: "RouletteProbabilitySchedule",
          entityId,
          oldValue,
          newValue,
        } as Prisma.InputJsonValue,
      },
    });
  }
}

const conflict = (message: string): AppError => new AppError(message, 409, "CONFLICT");

const payoutCapacityError = (
  capacity: PayoutCapacity,
  maxPayoutPerGame: number,
  dailyPayoutRemaining: number,
): AppError => {
  const details = {
    fullPayout: capacity.fullPayout,
    maxPayoutPerGame,
    dailyPayoutRemaining,
  };
  if (capacity.limit === "DAILY") {
    return new AppError(
      "This bet's full win exceeds your remaining daily payout allowance",
      409,
      "ROULETTE_DAILY_PAYOUT_CAP",
      details,
    );
  }
  if (capacity.limit === "PER_GAME") {
    return new AppError(
      "This bet's full win exceeds the per-spin payout cap",
      400,
      "ROULETTE_GAME_PAYOUT_CAP",
      details,
    );
  }
  return new AppError(
    "This bet has no payable configured win",
    400,
    "ROULETTE_ZERO_PAYOUT",
    details,
  );
};

const probabilityScheduleOverlap = (overlap?: {
  id: string;
  startsAt: Date;
  endsAt: Date;
}): AppError =>
  new AppError(
    "The probability schedule overlaps an existing non-cancelled schedule",
    409,
    "ROULETTE_SCHEDULE_OVERLAP",
    overlap
      ? {
          conflictingScheduleId: overlap.id,
          startsAt: overlap.startsAt.toISOString(),
          endsAt: overlap.endsAt.toISOString(),
        }
      : undefined,
  );
