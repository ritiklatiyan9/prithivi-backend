import { mkdirSync } from "node:fs";
import path from "node:path";
import fp from "fastify-plugin";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { UPLOADS } from "../config/constants.js";

/**
 * Serves locally stored uploads at /uploads/* — the fallback storage when
 * Cloudinary is not configured. In production nginx should serve this
 * directory directly for performance; this plugin keeps the URL working
 * either way.
 */
export default fp(async (app: FastifyInstance) => {
  // Managed S3 media is resolved through /api/v1/uploads/:id/content. Do not
  // expose a stale local upload directory once the private bucket is active.
  if (env.AWS_S3_BUCKET) return;
  const root = path.resolve(process.cwd(), env.UPLOADS_DIR);
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    // A bad UPLOADS_DIR (e.g. an unwritable production path pasted into the
    // wrong env) must not take the whole API down — uploads just 404 until
    // the path is fixed.
    app.log.error({ err: error, root }, "uploads dir unavailable — /uploads disabled");
    return;
  }

  await app.register(fastifyStatic, {
    root,
    prefix: `${UPLOADS.PUBLIC_PREFIX}/`,
    decorateReply: false,
    index: false,
    list: false,
    maxAge: "7d",
  });
});
