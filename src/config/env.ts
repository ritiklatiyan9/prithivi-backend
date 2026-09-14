import { existsSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

// z.coerce.boolean() treats every non-empty string (including "false") as
// true. Environment variables are strings, so parse the accepted spellings
// explicitly—especially for TRUST_PROXY and public Swagger exposure.
export const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
      return true;
    case "false":
    case "0":
      return false;
    default:
      return value;
  }
}, z.boolean());

// Hosting dashboards commonly persist an intentionally blank optional value
// as an empty string. Treat that the same as an unset environment variable.
const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

// Environment-file precedence: .env.<NODE_ENV> first, then .env as fallback.
// Values already present in process.env (e.g. injected by PM2) always win.
const nodeEnv = process.env.NODE_ENV ?? "development";
for (const file of [`.env.${nodeEnv}`, ".env"]) {
  const fullPath = path.resolve(process.cwd(), file);
  if (existsSync(fullPath)) {
    dotenv.config({ path: fullPath });
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  API_PREFIX: z.string().default("/api/v1"),
  LOG_LEVEL: z.string().default("info"),
  /** Public base URL of the API (behind nginx), used to build absolute upload URLs. */
  APP_URL: z.string().default("http://localhost:4000"),
  /** Enable when running behind a reverse proxy so client IPs come from X-Forwarded-For. */
  TRUST_PROXY: envBoolean.default(false),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters (use a generated random secret)"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),
  JWT_ISSUER: z.string().default("money-marathon"),
  JWT_AUDIENCE: z.string().default("money-marathon-clients"),

  // Firebase Admin (verifies Firebase ID tokens — the only auth provider).
  // Provide ONE of: a path to the service-account JSON, or the JSON itself
  // (raw or base64-encoded). Required for sign-in to work.
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),

  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  SWAGGER_ROUTE: z.string().default("/docs"),
  /** Disable Swagger UI entirely (recommended on public production APIs). */
  SWAGGER_ENABLED: envBoolean.default(nodeEnv !== "production"),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100_000).default(100),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),

  // Xoxoday Plum Reward Links. Leave ACCESS_TOKEN unset to run redemptions in
  // manual-fulfillment mode. Sandbox base:
  // https://stagingstores.xoxoday.com/chef/v1/oauth
  XOXODAY_BASE_URL: z.string().url().default("https://accounts.xoxoday.com/chef/v1/oauth"),
  XOXODAY_ACCESS_TOKEN: z.string().optional(),
  XOXODAY_REFRESH_TOKEN: z.string().optional(),
  XOXODAY_CLIENT_ID: z.string().optional(),
  XOXODAY_CLIENT_SECRET: z.string().optional(),
  XOXODAY_TOKEN_STATE_FILE: z.string().optional(),
  /** Default Reward Link campaign; individual catalog items may override it. */
  XOXODAY_CAMPAIGN_ID: z.string().default(""),
  XOXODAY_LINK_EXPIRY_DAYS: z.coerce.number().int().min(1).max(3650).default(90),

  // Razorpay Standard Checkout. The key id is returned only as part of an
  // authenticated order response; the secret never leaves this server.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_API_BASE_URL: z.string().url().default("https://api.razorpay.com/v1"),
  RAZORPAY_LUDO_PLUS_PLAN_ID: z.string().optional(),
  RAZORPAY_LUDO_PRO_PLAN_ID: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Previous webhook secret accepted only during an intentional rotation window. */
  RAZORPAY_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),

  // WebRTC discovery/relay configuration returned only to authenticated Ludo
  // Pro players. Comma-separated URL lists keep deployment configuration simple.
  LUDO_STUN_URLS: z.string().optional(),
  LUDO_TURN_URLS: z.string().optional(),
  LUDO_TURN_USERNAME: z.string().optional(),
  LUDO_TURN_CREDENTIAL: z.string().optional(),

  /** cloudinary://<api_key>:<api_secret>@<cloud_name> — falls back to local disk when unset. */
  CLOUDINARY_URL: z.string().optional(),
  /** Private S3 media bucket. When set, S3 takes precedence over Cloudinary/local storage. */
  AWS_S3_BUCKET: z.string().min(3).optional(),
  AWS_S3_REGION: z.string().default("ap-south-1"),
  /** Optional S3-compatible endpoint used only for local/testing providers. */
  AWS_S3_ENDPOINT: optionalUrl,
  AWS_S3_FORCE_PATH_STYLE: envBoolean.default(false),
  AWS_S3_KEY_PREFIX: z.string().default("money-marathon"),
  /** Short-lived redirect target; the stable application media URL never expires. */
  AWS_S3_SIGNED_URL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  UPLOADS_DIR: z.string().default("uploads"),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(20 * 1024 * 1024)
    .default(5 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable list of what's missing/invalid.
  console.error("❌ Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env: Env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
