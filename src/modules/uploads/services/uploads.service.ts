import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { MediaAsset, PrismaClient } from "@prisma/client";
import { v2 as cloudinary } from "cloudinary";
import sharp from "sharp";
import { BadRequestError, ConflictError, NotFoundError } from "../../../common/errors.js";
import { env } from "../../../config/env.js";
import { UPLOADS } from "../../../config/constants.js";

export const MEDIA_PURPOSES = ["PROOF", "CONTENT", "AVATAR", "NOTIFICATION"] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

export interface UploadResult {
  id: string;
  url: string;
  provider: "s3" | "cloudinary" | "local";
  mimeType: string;
  byteSize: number;
  originalByteSize: number;
  width: number | null;
  height: number | null;
}

interface StoredImage {
  provider: UploadResult["provider"];
  objectKey: string;
  sourceUrl?: string;
}

const streamToBuffer = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
};

export const optimizeImage = async (
  original: Buffer,
): Promise<{ data: Buffer; info: sharp.OutputInfo }> => {
  try {
    return await sharp(original, {
      failOn: "error",
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize({
        width: UPLOADS.IMAGE_MAX_EDGE,
        height: UPLOADS.IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({
        quality: UPLOADS.WEBP_QUALITY,
        nearLossless: true,
        smartSubsample: true,
        effort: 4,
      })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new BadRequestError("The uploaded file is not a valid image");
  }
};

export class UploadsService {
  private readonly cloudinaryEnabled = Boolean(env.CLOUDINARY_URL);
  private readonly s3: S3Client | null;

  constructor(private readonly prisma: PrismaClient) {
    if (this.cloudinaryEnabled) cloudinary.config({ secure: true });
    this.s3 = env.AWS_S3_BUCKET
      ? new S3Client({
          region: env.AWS_S3_REGION,
          ...(env.AWS_S3_ENDPOINT ? { endpoint: env.AWS_S3_ENDPOINT } : {}),
          forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE,
        })
      : null;
  }

  async uploadImage(
    stream: Readable,
    mimeType: string,
    options: { purpose: MediaPurpose; uploaderId: string; fileName?: string },
  ): Promise<UploadResult> {
    if (!(UPLOADS.ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
      throw new BadRequestError(
        `Unsupported file type "${mimeType}". Allowed: ${UPLOADS.ALLOWED_MIME_TYPES.join(", ")}`,
      );
    }

    const original = await streamToBuffer(stream);
    if (original.length === 0) throw new BadRequestError("The uploaded image is empty");
    if (original.length > env.UPLOAD_MAX_BYTES) {
      throw new BadRequestError("File exceeds the maximum allowed size");
    }

    const { data: optimized, info } = await optimizeImage(original);

    const objectId = randomUUID();
    const stored = this.s3
      ? await this.uploadToS3(optimized, options.purpose, objectId)
      : this.cloudinaryEnabled
        ? await this.uploadToCloudinary(optimized, options.purpose, objectId)
        : await this.uploadToDisk(optimized, objectId);

    try {
      const asset = await this.prisma.mediaAsset.create({
        data: {
          accessToken: randomBytes(24).toString("base64url"),
          storageProvider: stored.provider,
          objectKey: stored.objectKey,
          sourceUrl: stored.sourceUrl ?? null,
          purpose: options.purpose,
          originalFileName: options.fileName?.slice(0, 255) ?? null,
          mimeType: "image/webp",
          byteSize: optimized.length,
          originalByteSize: original.length,
          width: info.width,
          height: info.height,
          uploadedById: options.uploaderId,
        },
      });
      return this.toUploadResult(asset);
    } catch (error) {
      await this.deleteStored(stored).catch(() => undefined);
      throw error;
    }
  }

  /** Only proof images uploaded by this user may be attached to a submission. */
  async assertOwnedProofUrls(urls: string[], userId: string): Promise<void> {
    const identities = urls.map((url) => this.parseManagedUrl(url));
    if (identities.some((value) => value === null)) {
      throw new BadRequestError("Proof images must be uploaded through Money Marathon");
    }
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        OR: identities.map((value) => ({ id: value!.id, accessToken: value!.token })),
        uploadedById: userId,
        purpose: "PROOF",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (assets.length !== urls.length) {
      throw new BadRequestError("One or more proof images are invalid or no longer available");
    }
  }

  async contentLocation(
    id: string,
    token: string,
  ): Promise<{
    redirectUrl?: string;
    localPath?: string;
    mimeType: string;
  }> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id, accessToken: token, status: "ACTIVE" },
    });
    if (!asset) throw new NotFoundError("Image not found");

    if (asset.storageProvider === "s3") {
      if (!this.s3 || !env.AWS_S3_BUCKET) throw new NotFoundError("Image storage unavailable");
      return {
        redirectUrl: await getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: asset.objectKey }),
          { expiresIn: env.AWS_S3_SIGNED_URL_SECONDS },
        ),
        mimeType: asset.mimeType,
      };
    }
    if (asset.storageProvider === "cloudinary" && asset.sourceUrl) {
      return { redirectUrl: asset.sourceUrl, mimeType: asset.mimeType };
    }
    return {
      localPath: path.join(path.resolve(process.cwd(), env.UPLOADS_DIR), asset.objectKey),
      mimeType: asset.mimeType,
    };
  }

  async listAdmin(input: {
    page: number;
    limit: number;
    purpose?: string;
    status?: string;
    search?: string;
  }) {
    const where = {
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.search
        ? { originalFileName: { contains: input.search, mode: "insensitive" as const } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.mediaAsset.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      this.prisma.mediaAsset.count({ where }),
    ]);
    return {
      items: items.map((asset) => ({
        ...this.toUploadResult(asset),
        purpose: asset.purpose,
        status: asset.status,
        originalFileName: asset.originalFileName,
        uploadedById: asset.uploadedById,
        retiredAt: asset.retiredAt?.toISOString() ?? null,
        createdAt: asset.createdAt.toISOString(),
      })),
      total,
    };
  }

  async retire(id: string, retiredById: string, force: boolean) {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundError("Image not found");
    if (asset.status === "RETIRED") return { id, status: "RETIRED", references: 0 };

    const references = await this.countReferences(this.mediaUrl(asset));
    if (references > 0 && !force) {
      throw new ConflictError(
        `This image is still used in ${references} place${references === 1 ? "" : "s"}. Remove those references first or confirm permanent retirement.`,
      );
    }

    await this.deleteStored({
      provider: asset.storageProvider as StoredImage["provider"],
      objectKey: asset.objectKey,
      ...(asset.sourceUrl ? { sourceUrl: asset.sourceUrl } : {}),
    });
    await this.prisma.mediaAsset.update({
      where: { id },
      data: { status: "RETIRED", retiredAt: new Date(), retiredById },
    });
    return { id, status: "RETIRED", references };
  }

  private async uploadToS3(body: Buffer, purpose: MediaPurpose, id: string): Promise<StoredImage> {
    const prefix = env.AWS_S3_KEY_PREFIX.replace(/^\/+|\/+$/g, "");
    const key = `${prefix}/${purpose.toLowerCase()}/${new Date().toISOString().slice(0, 10)}/${id}.webp`;
    await this.s3!.send(
      new PutObjectCommand({
        Bucket: env.AWS_S3_BUCKET!,
        Key: key,
        Body: body,
        ContentType: "image/webp",
        ContentDisposition: "inline",
        CacheControl: "private, max-age=31536000, immutable",
        ServerSideEncryption: "AES256",
      }),
    );
    return { provider: "s3", objectKey: key };
  }

  private uploadToCloudinary(
    body: Buffer,
    purpose: MediaPurpose,
    id: string,
  ): Promise<StoredImage> {
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        {
          folder: `${UPLOADS.CLOUDINARY_FOLDER}/${purpose.toLowerCase()}`,
          public_id: id,
          resource_type: "image",
          format: "webp",
        },
        (error, result) => {
          if (error || !result) {
            reject(new BadRequestError(error?.message ?? "Cloudinary upload failed"));
            return;
          }
          resolve({
            provider: "cloudinary",
            objectKey: result.public_id,
            sourceUrl: result.secure_url,
          });
        },
      );
      upload.end(body);
    });
  }

  private async uploadToDisk(body: Buffer, id: string): Promise<StoredImage> {
    const filename = `${id}.webp`;
    const dir = path.resolve(process.cwd(), env.UPLOADS_DIR);
    mkdirSync(dir, { recursive: true });
    await writeFile(path.join(dir, filename), body);
    return { provider: "local", objectKey: filename };
  }

  private async deleteStored(stored: StoredImage): Promise<void> {
    if (stored.provider === "s3") {
      if (this.s3 && env.AWS_S3_BUCKET) {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET, Key: stored.objectKey }),
        );
      }
      return;
    }
    if (stored.provider === "cloudinary") {
      await cloudinary.uploader.destroy(stored.objectKey, { resource_type: "image" });
      return;
    }
    await unlink(path.join(path.resolve(process.cwd(), env.UPLOADS_DIR), stored.objectKey)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }

  private toUploadResult(asset: MediaAsset): UploadResult {
    return {
      id: asset.id,
      url: this.mediaUrl(asset),
      provider: asset.storageProvider as UploadResult["provider"],
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      originalByteSize: asset.originalByteSize,
      width: asset.width,
      height: asset.height,
    };
  }

  private mediaUrl(asset: Pick<MediaAsset, "id" | "accessToken">): string {
    return `${env.APP_URL.replace(/\/$/, "")}${env.API_PREFIX}/uploads/${asset.id}/content?token=${asset.accessToken}`;
  }

  private parseManagedUrl(url: string): { id: string; token: string } | null {
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/uploads\/([0-9a-f-]{36})\/content$/i);
      const token = parsed.searchParams.get("token");
      return match && token ? { id: match[1], token } : null;
    } catch {
      return null;
    }
  }

  private async countReferences(url: string): Promise<number> {
    const counts = await Promise.all([
      this.prisma.user.count({ where: { avatarUrl: url } }),
      this.prisma.notification.count({ where: { imageUrl: url } }),
      this.prisma.pushLog.count({ where: { imageUrl: url } }),
      this.prisma.offerCategory.count({ where: { imageUrl: url } }),
      this.prisma.feedbackPage.count({ where: { bannerUrl: url } }),
      this.prisma.offer.count({
        where: {
          OR: [{ logoUrl: url }, { thumbnailUrl: url }, { bannerUrl: url }, { brandLogoUrl: url }],
        },
      }),
      this.prisma.offerSubmission.count({ where: { screenshotUrl: url } }),
      this.prisma.submissionImage.count({ where: { url } }),
      this.prisma.voucherOffer.count({ where: { imageUrl: url } }),
      this.prisma.appAsset.count({ where: { imageUrl: url } }),
    ]);
    return counts.reduce((sum, count) => sum + count, 0);
  }
}
