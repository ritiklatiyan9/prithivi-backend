import { BadRequestError } from "../../../common/errors.js";
import type { SettingsRepository } from "../repositories/settings.repository.js";
import {
  SETTINGS_BY_KEY,
  SETTINGS_REGISTRY,
  type SettingDefinition,
  type SettingDto,
  type UpdateSettingsInput,
} from "../schemas/settings.schema.js";

/**
 * Reads reward-system settings with an in-memory cache (60s TTL so a
 * PM2-cluster peer picks up changes without pub/sub). Values fall back to the
 * code registry default, so a caller is never blocked by a missing row.
 */
export class SettingsService {
  private cache: Map<string, string> | null = null;
  private loadedAt = 0;
  private generation = 0;
  private inFlightLoad: {
    generation: number;
    promise: Promise<Map<string, string>>;
  } | null = null;
  private static readonly TTL_MS = 60_000;

  constructor(private readonly repo: SettingsRepository) {}

  private async overrides(): Promise<Map<string, string>> {
    if (this.cache && Date.now() - this.loadedAt < SettingsService.TTL_MS) {
      return this.cache;
    }

    // Several modules resolve a group of settings with Promise.all. Without
    // single-flight protection, the first request after boot/expiry performed
    // one identical SELECT per setting. Share that cold load across every
    // caller so it remains exactly one database round trip.
    const generation = this.generation;
    if (this.inFlightLoad?.generation === generation) {
      return this.inFlightLoad.promise;
    }

    const promise = this.repo
      .findAll()
      .then((rows) => new Map(rows.map((row) => [row.key, row.value])));
    this.inFlightLoad = { generation, promise };

    try {
      const loaded = await promise;
      // An admin update may finish while an older read is in flight. Never
      // repopulate the cache with that stale snapshot; reload the new version.
      if (generation !== this.generation) return this.overrides();
      this.cache = loaded;
      this.loadedAt = Date.now();
      return loaded;
    } finally {
      if (this.inFlightLoad?.promise === promise) this.inFlightLoad = null;
    }
  }

  private async raw(key: string): Promise<string> {
    const definition = SETTINGS_BY_KEY[key];
    if (!definition) throw new BadRequestError(`Unknown setting "${key}"`);
    const override = (await this.overrides()).get(key);
    return override ?? definition.default;
  }

  // ---- typed getters (used by other modules) ----

  async getNumber(key: string): Promise<number> {
    const definition = SETTINGS_BY_KEY[key];
    const parsed = Number(await this.raw(key));
    const valid =
      Number.isFinite(parsed) &&
      (definition.integer !== true || Number.isInteger(parsed)) &&
      (definition.min === undefined || parsed >= definition.min) &&
      (definition.max === undefined || parsed <= definition.max);
    return valid ? parsed : Number(definition.default);
  }

  async getBoolean(key: string): Promise<boolean> {
    return (await this.raw(key)) === "true";
  }

  async getString(key: string): Promise<string> {
    const value = await this.raw(key);
    if (key === "game.roulette.resetTimezone" && !SettingsService.isValidIanaTimezone(value)) {
      return SETTINGS_BY_KEY[key].default;
    }
    return value;
  }

  // ---- admin ----

  async list(): Promise<SettingDto[]> {
    const overrides = await this.overrides();
    return SETTINGS_REGISTRY.map((definition) => {
      const override = overrides.get(definition.key);
      const resolved = override ?? definition.default;
      const secret = definition.secret === true;
      return {
        key: definition.key,
        // Secrets are write-only: never leak the stored credential over the API.
        value: secret ? "" : resolved,
        type: definition.type,
        category: definition.category,
        label: definition.label,
        description: definition.description,
        isDefault: override === undefined,
        secret,
        hasValue: resolved.trim().length > 0,
      } satisfies SettingDto;
    });
  }

  async update(input: UpdateSettingsInput, updatedById: string | undefined): Promise<SettingDto[]> {
    const entries = Object.entries(input.values)
      .filter(([key, value]) => {
        if (key === "game.roulette.probabilityMode") {
          throw new BadRequestError(
            '"game.roulette.probabilityMode" is retired; use a timed roulette probability schedule',
          );
        }
        const definition = SETTINGS_BY_KEY[key];
        if (!definition) throw new BadRequestError(`Unknown setting "${key}"`);
        // A blank secret submission means "keep the existing value".
        return !(definition.secret === true && value.trim() === "");
      })
      .map(([key, value]) => ({ key, value: this.coerce(SETTINGS_BY_KEY[key], value) }));

    if (entries.length > 0) {
      await this.repo.upsertMany(entries, updatedById);
      this.generation += 1;
      this.cache = null; // force reload on next read within this process
    }
    return this.list();
  }

  /** Validate + normalize a submitted string against its declared type. */
  private coerce(definition: SettingDefinition, value: string): string {
    switch (definition.type) {
      case "BOOLEAN": {
        if (value !== "true" && value !== "false") {
          throw new BadRequestError(`"${definition.key}" must be true or false`);
        }
        return value;
      }
      case "NUMBER": {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          throw new BadRequestError(`"${definition.key}" must be a number`);
        }
        if (definition.integer === true && !Number.isInteger(parsed)) {
          throw new BadRequestError(`"${definition.key}" must be an integer`);
        }
        if (definition.min !== undefined && parsed < definition.min) {
          throw new BadRequestError(`"${definition.key}" must be >= ${definition.min}`);
        }
        if (definition.max !== undefined && parsed > definition.max) {
          throw new BadRequestError(`"${definition.key}" must be <= ${definition.max}`);
        }
        return String(parsed);
      }
      default: {
        const trimmed = value.trim();
        if (definition.enum && !definition.enum.includes(trimmed)) {
          throw new BadRequestError(
            `"${definition.key}" must be one of: ${definition.enum.join(", ")}`,
          );
        }
        if (definition.key === "game.roulette.resetTimezone") {
          if (!SettingsService.isValidIanaTimezone(trimmed)) {
            throw new BadRequestError(`"${definition.key}" must be a valid IANA timezone`);
          }
        }
        return trimmed;
      }
    }
  }

  private static isValidIanaTimezone(value: string): boolean {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }
}
