import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { AppError } from "../common/errors.js";
import { failure } from "../common/response.js";
import { env, isProduction } from "../config/env.js";

export const errorHandler = (
  error: FastifyError | AppError | ZodError,
  request: FastifyRequest,
  reply: FastifyReply,
): void => {
  if (error instanceof AppError) {
    if (error.statusCode >= 500) request.log.error(error);
    reply.status(error.statusCode).send(failure(error.code, error.message, error.details));
    return;
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    reply.status(400).send(
      failure(
        "VALIDATION_ERROR",
        "Request validation failed",
        error.validation.map((issue) => ({
          path: issue.instancePath || issue.params?.issue?.path?.join("."),
          message: issue.message,
        })),
      ),
    );
    return;
  }

  if (error instanceof ZodError) {
    reply.status(400).send(
      failure(
        "VALIDATION_ERROR",
        "Validation failed",
        error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      ),
    );
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2021") {
      reply
        .status(503)
        .send(
          failure(
            "DATABASE_MIGRATION_PENDING",
            isProduction
              ? "Server database schema is not up to date"
              : `Prisma ${error.code}: ${error.message}`,
          ),
        );
      return;
    }
    if (error.code === "P2002") {
      reply.status(409).send(failure("CONFLICT", "A record with these values already exists"));
      return;
    }
    if (error.code === "P2025") {
      reply.status(404).send(failure("NOT_FOUND", "Resource not found"));
      return;
    }
    request.log.error(error);
    // The Prisma error code (e.g. P2024 pool timeout, P2021 missing table) is not
    // sensitive and is invaluable for diagnosis, so include it. The full message
    // (which can contain query details) is only exposed outside production.
    reply
      .status(500)
      .send(
        failure(
          `DATABASE_ERROR_${error.code}`,
          isProduction ? "Database operation failed" : `Prisma ${error.code}: ${error.message}`,
        ),
      );
    return;
  }

  const statusCode = "statusCode" in error && error.statusCode ? error.statusCode : 500;

  if (statusCode >= 500) {
    request.log.error(error);
    reply
      .status(statusCode)
      .send(
        failure(
          "INTERNAL_ERROR",
          env.NODE_ENV === "production" ? "Internal server error" : error.message,
        ),
      );
    return;
  }

  reply
    .status(statusCode)
    .send(failure(("code" in error && error.code) || "REQUEST_ERROR", error.message));
};
