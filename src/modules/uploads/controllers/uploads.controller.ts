import { createReadStream } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { BadRequestError } from "../../../common/errors.js";
import { success } from "../../../common/response.js";
import {
  MEDIA_PURPOSES,
  type MediaPurpose,
  type UploadsService,
} from "../services/uploads.service.js";

export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  upload = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const file = await request.file();
    if (!file) {
      throw new BadRequestError('No file provided (multipart field name: "file")');
    }
    const rawPurpose = String(
      (request.query as { purpose?: string }).purpose ?? "PROOF",
    ).toUpperCase();
    if (!MEDIA_PURPOSES.includes(rawPurpose as MediaPurpose)) {
      throw new BadRequestError(`Unknown media purpose "${rawPurpose}"`);
    }

    const result = await this.uploadsService.uploadImage(file.file, file.mimetype, {
      purpose: rawPurpose as MediaPurpose,
      uploaderId: request.user.sub,
      fileName: file.filename,
    });

    if (file.file.truncated) {
      await this.uploadsService.retire(result.id, request.user.sub, true);
      throw new BadRequestError("File exceeds the maximum allowed size");
    }

    reply.status(201).send(success(result));
  };

  content = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id } = request.params as { id: string };
    const token = String((request.query as { token?: string }).token ?? "");
    if (!token) throw new BadRequestError("Missing image access token");
    const location = await this.uploadsService.contentLocation(id, token);
    reply.header("Cache-Control", "private, max-age=300, stale-while-revalidate=60");
    if (location.redirectUrl) {
      reply.redirect(location.redirectUrl);
      return;
    }
    reply.type(location.mimeType).send(createReadStream(location.localPath!));
  };

  listAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const query = request.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 24));
    const result = await this.uploadsService.listAdmin({
      page,
      limit,
      ...(query.purpose && query.purpose !== "ALL" ? { purpose: query.purpose } : {}),
      ...(query.status && query.status !== "ALL" ? { status: query.status } : {}),
      ...(query.search?.trim() ? { search: query.search.trim() } : {}),
    });
    reply.send(
      success(result.items, {
        page,
        limit,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / limit)),
      }),
    );
  };

  retire = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const { id } = request.params as { id: string };
    const force = String((request.query as { force?: string }).force) === "true";
    reply.send(success(await this.uploadsService.retire(id, request.user.sub, force)));
  };
}
