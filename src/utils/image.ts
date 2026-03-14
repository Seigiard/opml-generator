import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../logging/index.ts";
export { COVER_MAX_SIZE } from "../constants.ts";

export async function saveBufferAsImage(buffer: Buffer, destPath: string, maxSize: number): Promise<boolean> {
  try {
    await mkdir(dirname(destPath), { recursive: true });
    const resize = `${maxSize}x${maxSize}>`;
    const proc = Bun.spawn(["magick", "-", "-resize", resize, "-colorspace", "sRGB", "-quality", "90", destPath], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin.write(buffer);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch (error) {
    log.warn("Image", "Failed to save buffer as image", { file: destPath, error: String(error) });
    return false;
  }
}
