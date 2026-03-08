import { parseBuffer } from "music-metadata";
import { basename, extname } from "node:path";
import type { AudioMetadata, CoverArt } from "./types.ts";

export async function readAudioMetadata(filePath: string): Promise<AudioMetadata> {
  const buf = new Uint8Array(await Bun.file(filePath).arrayBuffer());
  const metadata = await parseBuffer(buf, { path: filePath });

  const { common, format } = metadata;

  return {
    title: common.title ?? basename(filePath, extname(filePath)),
    artist: common.artist,
    album: common.album,
    discNumber: common.disk?.no ?? undefined,
    trackNumber: common.track?.no ?? undefined,
    duration: format.duration,
    date: common.date ?? common.year?.toString(),
    genre: common.genre?.[0],
  };
}

export async function extractEmbeddedCover(filePath: string): Promise<CoverArt | null> {
  const buf = new Uint8Array(await Bun.file(filePath).arrayBuffer());
  const metadata = await parseBuffer(buf, { path: filePath });

  const picture = metadata.common.picture?.[0];
  if (!picture) return null;

  return {
    data: Buffer.from(picture.data),
    format: picture.format,
  };
}
