import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { basename } from "node:path";
import type { FileInfo } from "../types.ts";
import { MIME_TYPES } from "../types.ts";

const parser = new XMLParser({ parseTagValue: false });

const text = z.string().min(1);

const number = z.coerce.number<string>().finite().nonnegative();

const episodeSchema = z.object({
  episode: z.object({
    title: text,
    fileName: text,
    filePath: text,
    fileSize: text.pipe(number.int()),
    mimeType: text,
    duration: text.pipe(number).optional(),
    discNumber: text.pipe(number.int()).optional(),
    trackNumber: text.pipe(number.int()).optional(),
    episodeNumber: text.pipe(number.int().positive()),
    pubDate: text.refine((value) => Number.isFinite(Date.parse(value))),
    guid: text,
  }),
});

export function isReusableEpisodeCache(content: string, file: FileInfo): boolean {
  if (XMLValidator.validate(content) !== true) return false;

  const parsed = episodeSchema.safeParse(parser.parse(content));

  if (!parsed.success) return false;

  const episode = parsed.data.episode;

  return (
    episode.fileName === basename(file.relativePath) &&
    episode.filePath === file.relativePath &&
    episode.guid === file.relativePath &&
    episode.fileSize === file.size &&
    episode.mimeType === MIME_TYPES.get(file.extension)
  );
}
