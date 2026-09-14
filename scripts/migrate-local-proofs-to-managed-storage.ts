import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { env } from "../src/config/env.js";
import { UploadsService } from "../src/modules/uploads/services/uploads.service.js";

if (!env.AWS_S3_BUCKET) {
  throw new Error(
    "AWS_S3_BUCKET is required; refusing to migrate proof files to a fallback provider",
  );
}

const prisma = new PrismaClient();
const uploads = new UploadsService(prisma);
const rows = await prisma.submissionImage.findMany({
  where: { url: { contains: "/uploads/" } },
  select: {
    url: true,
    submission: { select: { userId: true } },
  },
});

const unique = new Map(rows.map((row) => [row.url, row]));
let migrated = 0;
let missing = 0;

for (const [oldUrl, row] of unique) {
  const oldName = new URL(oldUrl).pathname.split("/").pop();
  if (!oldName) continue;
  const localPath = path.join(path.resolve(process.cwd(), env.UPLOADS_DIR), oldName);
  if (!existsSync(localPath)) {
    missing += 1;
    continue;
  }
  const extension = path.extname(oldName).toLowerCase();
  const mimeType =
    extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
  const result = await uploads.uploadImage(createReadStream(localPath), mimeType, {
    purpose: "PROOF",
    uploaderId: row.submission.userId,
    fileName: oldName,
  });
  await prisma.$transaction([
    prisma.submissionImage.updateMany({ where: { url: oldUrl }, data: { url: result.url } }),
    prisma.offerSubmission.updateMany({
      where: { screenshotUrl: oldUrl },
      data: { screenshotUrl: result.url },
    }),
  ]);
  migrated += 1;
}

console.log({ uniqueProofUrls: unique.size, migrated, missing });
await prisma.$disconnect();
