const FIRST_PARTY_WEB_ORIGINS = new Set([
  "https://moneymarathon.in",
  "https://www.moneymarathon.in",
]);

/**
 * Browser Origin headers never contain a path, but deployment environment
 * values are often pasted with a trailing slash. Compare URL origins so that
 * harmless formatting cannot take the proof-upload endpoint offline.
 */
const normalizeOrigin = (value: string): string => {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
};

export const isCorsOriginAllowed = (
  origin: string | undefined,
  configuredOrigins: string,
  production: boolean,
): boolean => {
  // Native apps, curl and server-to-server requests do not send Origin.
  if (!origin) return true;

  const normalized = normalizeOrigin(origin);
  const configured = new Set(configuredOrigins.split(",").map(normalizeOrigin).filter(Boolean));

  // These are the two canonical public-site hosts. The apex redirects to www,
  // so both must remain valid even if a Render environment value is stale.
  if (FIRST_PARTY_WEB_ORIGINS.has(normalized) || configured.has(normalized)) {
    return true;
  }

  // Local previews stay convenient outside production only.
  return !production && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized);
};
