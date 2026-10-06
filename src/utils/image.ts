import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../logging/index.ts";

export { COVER_MAX_SIZE } from "../constants.ts";

export async function saveBufferAsImage(
  buffer: Buffer,
  destPath: string,
  maxSize: number,
  beforeWrite?: () => void,
): Promise<boolean> {
  try {
    beforeWrite?.();
    await mkdir(dirname(destPath), { recursive: true });
    beforeWrite?.();
    await sharp(buffer)
      .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true })
      .toColorspace("srgb")
      .jpeg({ quality: 90 })
      .toFile(destPath);

    return true;
  } catch (error) {
    log.warn("Image", "Failed to save buffer as image", { file: destPath, error: String(error) });

    return false;
  }
}
