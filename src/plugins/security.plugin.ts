import fp from "fastify-plugin";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { env, isProduction } from "../config/env.js";
import { isCorsOriginAllowed } from "./cors-origin.js";

export default fp(
  async (app: FastifyInstance) => {
    await app.register(helmet, {
      // The API serves JSON (and Swagger UI); a strict CSP breaks Swagger assets.
      contentSecurityPolicy: isProduction && !env.SWAGGER_ENABLED ? undefined : false,
      crossOriginResourcePolicy: { policy: "cross-origin" }, // uploaded images are embedded cross-origin
    });

    await app.register(cors, {
      origin: (origin, callback) => {
        if (isCorsOriginAllowed(origin, env.CORS_ORIGIN, isProduction)) {
          callback(null, true);
          return;
        }
        callback(new Error("Not allowed by CORS"), false);
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    });

    await app.register(rateLimit, {
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW,
      // ponytail: in-memory store — correct for a single instance; bring back
      // a shared store only if the API ever runs multiple replicas.
    });

    // NOTE: app-level gzip is intentionally NOT enabled. @fastify/compress@9
    // returned empty bodies (content-length: 0) for any response over its
    // threshold when the client sent `Accept-Encoding: gzip` — which every
    // mobile/browser client does — silently breaking large responses and
    // spamming ERR_STREAM_PREMATURE_CLOSE. For a JSON API, compression belongs
    // at the reverse proxy / CDN (nginx gzip, Cloudflare, Fly) in production.
  },
  { name: "security" },
);
