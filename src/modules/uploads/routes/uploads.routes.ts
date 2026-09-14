import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { authGuard } from "../../../middleware/auth-guard.js";
import { superAdminOnly } from "../../../middleware/role-guard.js";
import { env } from "../../../config/env.js";

export const uploadsRoutes = async (app: FastifyInstance): Promise<void> => {
  await app.register(multipart, {
    limits: {
      fileSize: env.UPLOAD_MAX_BYTES,
      files: 1,
    },
  });

  app.get(
    "/admin",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["admin"],
        summary: "List managed media",
        security: [{ bearerAuth: [] }],
      },
    },
    app.di.uploadsController.listAdmin,
  );

  app.delete(
    "/admin/:id",
    {
      preHandler: [authGuard, superAdminOnly],
      schema: {
        tags: ["admin"],
        summary: "Retire a managed image and delete its stored object",
        security: [{ bearerAuth: [] }],
      },
    },
    app.di.uploadsController.retire,
  );

  // The random token makes this a capability URL. It can be rendered by img
  // tags without putting an admin/user bearer token into the URL or S3 bucket.
  app.get(
    "/:id/content",
    {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
      schema: { tags: ["users"], summary: "Resolve a private managed image" },
    },
    app.di.uploadsController.content,
  );

  app.post(
    "/",
    {
      preHandler: [authGuard],
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["users"],
        summary: "Optimize and upload an image to managed storage",
        security: [{ bearerAuth: [] }],
        consumes: ["multipart/form-data"],
      },
    },
    app.di.uploadsController.upload,
  );
};
