CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "accessToken" TEXT NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'PROOF',
    "originalFileName" TEXT,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "originalByteSize" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "uploadedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "retiredById" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_assets_accessToken_key" ON "media_assets"("accessToken");
CREATE INDEX "media_assets_status_createdAt_idx" ON "media_assets"("status", "createdAt");
CREATE INDEX "media_assets_purpose_status_createdAt_idx" ON "media_assets"("purpose", "status", "createdAt");
CREATE INDEX "media_assets_uploadedById_createdAt_idx" ON "media_assets"("uploadedById", "createdAt");
