/** Centralized application constants — single source of truth for magic values. */

export const ROLES = {
  USER: "USER",
  ADMIN: "ADMIN",
  SUPER_ADMIN: "SUPER_ADMIN",
} as const;

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
} as const;

export const UPLOADS = {
  ALLOWED_MIME_TYPES: ["image/jpeg", "image/png", "image/webp"],
  PUBLIC_PREFIX: "/uploads",
  CLOUDINARY_FOLDER: "rewardhub",
  IMAGE_MAX_EDGE: 2_048,
  WEBP_QUALITY: 88,
} as const;

export const AUDIT = {
  /** Only mutating verbs are audited. */
  METHODS: ["POST", "PATCH", "PUT", "DELETE"],
  /** Paths that must never land in the audit log (sensitive payloads). */
  EXCLUDED_PATH_FRAGMENTS: ["/auth/"],
} as const;

export const HEADERS = {
  REQUEST_ID: "x-request-id",
} as const;
