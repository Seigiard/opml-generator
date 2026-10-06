import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../logging/index.ts";

export { COVER_MAX_SIZE } from "../constants.ts";

export async function saveBufferAsImage(
  buffer: Buffer,
  destPath: string,
  maxSize: number,
  beforeWrite?: () => void | Promise<void>,
): Promise<boolean> {
  try {
    const image = await sharp(buffer)
      .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
      .toColorspace("srgb")
      .jpeg({ quality: 90 })
      .toBuffer();

    await beforeWrite?.();
    await mkdir(dirname(destPath), { recursive: true });
    await beforeWrite?.();
    await Bun.write(destPath, image);

    return true;
  } catch (error) {
    log.warn("Image", "Failed to save buffer as image", { file: destPath, error: String(error) });

    return false;
  }
}
