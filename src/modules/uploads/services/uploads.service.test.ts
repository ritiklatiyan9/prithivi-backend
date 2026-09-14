import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../../common/errors.js";
import { optimizeImage } from "./uploads.service.js";

describe("managed image optimization", () => {
  it("rotates, bounds and converts large images to quality WebP", async () => {
    const original = await sharp({
      create: {
        width: 3200,
        height: 2400,
        channels: 3,
        background: { r: 245, g: 238, b: 224 },
      },
    })
      .png()
      .toBuffer();

    const output = await optimizeImage(original);
    const metadata = await sharp(output.data).metadata();

    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(2048);
    expect(metadata.height).toBe(1536);
    expect(output.data.length).toBeLessThan(original.length);
  });

  it("rejects content that only claims to be an image", async () => {
    await expect(optimizeImage(Buffer.from("not an image"))).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});
