import { join } from "node:path";

const REFERENCE_COVER = join(import.meta.dir, "../../files/test/cover.jpg");

export async function compareImages(
  imageA: Buffer,
  imageB: Buffer,
  threshold = 0.1,
): Promise<{ similar: boolean; rmse: number }> {
  const id = Date.now();
  const tmpA = `/tmp/compare_a_${id}.jpg`;
  const tmpB = `/tmp/compare_b_${id}.jpg`;

  await Bun.write(tmpA, imageA);
  await Bun.write(tmpB, imageB);

  await Bun.$`magick ${tmpA} -resize 200x200! ${tmpA}`.quiet();
  await Bun.$`magick ${tmpB} -resize 200x200! ${tmpB}`.quiet();

  const proc = Bun.spawn(["magick", "compare", "-metric", "RMSE", tmpA, tmpB, "null:"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const match = stderr.match(/\(([\d.]+)\)/);
  const rmse = match?.[1] ? parseFloat(match[1]) : 1;

  await Bun.$`rm -f ${tmpA} ${tmpB}`.quiet();

  return { similar: rmse < threshold, rmse };
}

export async function assertCoverMatchesReference(
  extractedCover: Buffer,
  threshold = 0.1,
): Promise<void> {
  const referenceCover = await Bun.file(REFERENCE_COVER).arrayBuffer();
  const { similar, rmse } = await compareImages(
    extractedCover,
    Buffer.from(referenceCover),
    threshold,
  );

  if (!similar) {
    throw new Error(
      `Cover does not match reference: RMSE=${rmse.toFixed(4)} > threshold=${threshold}`,
    );
  }
}

export { REFERENCE_COVER };
