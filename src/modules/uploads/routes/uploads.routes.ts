import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { authGuard } from "../../../middleware/auth-guard.js";
import { env } from "../../../config/env.js";

export const uploadsRoutes = async (app: FastifyInstance): Promise<void> => {
  await app.register(multipart, {
    limits: {
      fileSize: env.UPLOAD_MAX_BYTES,
      files: 1,
    },
  });

  app.post(
    "/",
    {
      preHandler: [authGuard],
      // Storage and image processing are materially more expensive than JSON
      // reads; cap accidental retry storms and authenticated storage abuse.
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["users"],
        summary: "Upload an image (claim proof, avatar). Multipart field: file",
        security: [{ bearerAuth: [] }],
        consumes: ["multipart/form-data"],
      },
    },
    app.di.uploadsController.upload,
  );
};
