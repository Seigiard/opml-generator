import { Effect } from "effect";
import { join, basename, dirname, relative, extname } from "node:path";
import { XMLBuilder } from "fast-xml-parser";
import { MIME_TYPES } from "../../types.ts";
import { readAudioMetadata, extractEmbeddedCover } from "../../audio/id3-reader.ts";
import { findFolderCover } from "../../audio/cover.ts";
import { saveBufferAsImage, COVER_MAX_SIZE } from "../../utils/image.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { ENTRY_FILE, COVER_FILE } from "../../constants.ts";

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

function buildEpisodeXml(fields: Record<string, unknown>): string {
  return xmlBuilder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    episode: fields,
  }) as string;
}

export const audioSync = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "AudioFileCreated") return [];
    const { parent, name } = event;
    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;

    const ext = extname(name).slice(1).toLowerCase();
    const filePath = join(parent, name);
    const relativePath = relative(config.filesPath, filePath);
    const episodeDataDir = join(config.dataPath, relativePath);
    const folderDataDir = dirname(episodeDataDir);

    yield* logger.info("AudioSync", "Processing", { path: relativePath });

    const fileStat = yield* fs.stat(filePath);
    yield* fs.mkdir(episodeDataDir, { recursive: true });

    const metadata = yield* Effect.tryPromise({
      try: () => readAudioMetadata(filePath),
      catch: (e) => e as Error,
    }).pipe(
      Effect.catchAll(() =>
        Effect.succeed({
          title: basename(name, extname(name)),
        }),
      ),
    );

    const episodeNumber = yield* resolveEpisodeNumber(folderDataDir, episodeDataDir);
    const pubDate = yield* resolvePubDate(metadata.date, folderDataDir, episodeNumber);
    const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

    const episodeXml = buildEpisodeXml({
      title: metadata.title,
      fileName: name,
      filePath: relativePath,
      fileSize: fileStat.size,
      mimeType,
      ...(metadata.duration != null && { duration: Math.floor(metadata.duration) }),
      ...(metadata.discNumber != null && { discNumber: metadata.discNumber }),
      ...(metadata.trackNumber != null && { trackNumber: metadata.trackNumber }),
      episodeNumber,
      pubDate,
      guid: relativePath,
    });

    yield* fs.atomicWrite(join(episodeDataDir, ENTRY_FILE), episodeXml);
    yield* handleFolderCover(filePath, parent, folderDataDir);

    yield* logger.info("AudioSync", "Done", { path: relativePath, episode: episodeNumber });
    return [];
  });

const resolveEpisodeNumber = (folderDataDir: string, currentEpisodeDir: string): Effect.Effect<number, Error, FileSystemService> =>
  Effect.gen(function* () {
    const fs = yield* FileSystemService;
    const siblings = yield* fs.readdir(folderDataDir).pipe(Effect.catchAll(() => Effect.succeed([] as string[])));

    let maxEpisode = 0;
    for (const sibling of siblings) {
      const siblingDir = join(folderDataDir, sibling);
      if (siblingDir === currentEpisodeDir) continue;

      const entryPath = join(siblingDir, ENTRY_FILE);
      const exists = yield* fs.exists(entryPath);
      if (!exists) continue;

      const content = yield* Effect.tryPromise({
        try: () => Bun.file(entryPath).text(),
        catch: (e) => e as Error,
      }).pipe(Effect.catchAll(() => Effect.succeed("")));

      const match = content.match(/<episodeNumber>(\d+)<\/episodeNumber>/);
      if (match) {
        maxEpisode = Math.max(maxEpisode, Number.parseInt(match[1]!, 10));
      }
    }

    return maxEpisode + 1;
  });

const resolvePubDate = (
  id3Date: string | undefined,
  folderDataDir: string,
  episodeNumber: number,
): Effect.Effect<string, Error, FileSystemService> =>
  Effect.gen(function* () {
    if (id3Date) {
      const parsed = new Date(id3Date);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }

    const fs = yield* FileSystemService;
    const siblings = yield* fs.readdir(folderDataDir).pipe(Effect.catchAll(() => Effect.succeed([] as string[])));

    let earliestMtime = Date.now();
    for (const sibling of siblings) {
      const siblingDir = join(folderDataDir, sibling);
      const entryPath = join(siblingDir, ENTRY_FILE);
      const exists = yield* fs.exists(entryPath);
      if (!exists) continue;

      const content = yield* Effect.tryPromise({
        try: () => Bun.file(entryPath).text(),
        catch: (e) => e as Error,
      }).pipe(Effect.catchAll(() => Effect.succeed("")));

      const match = content.match(/<pubDate>([^<]+)<\/pubDate>/);
      if (match) {
        const parsed = new Date(match[1]!);
        if (!Number.isNaN(parsed.getTime())) {
          earliestMtime = Math.min(earliestMtime, parsed.getTime());
        }
      }
    }

    const baseDate = new Date(earliestMtime);
    const synthesized = new Date(baseDate.getTime() + (episodeNumber - 1) * 60_000);
    return synthesized.toISOString();
  });

const handleFolderCover = (
  audioFilePath: string,
  sourceFolder: string,
  folderDataDir: string,
): Effect.Effect<void, never, FileSystemService | LoggerService> =>
  Effect.gen(function* () {
    const fs = yield* FileSystemService;

    const coverPath = join(folderDataDir, COVER_FILE);
    const coverExists = yield* fs.exists(coverPath);
    if (coverExists) return;

    const folderCoverPath = yield* Effect.tryPromise({
      try: () => findFolderCover(sourceFolder),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (folderCoverPath) {
      const coverBuffer = yield* Effect.tryPromise({
        try: async () => Buffer.from(await Bun.file(folderCoverPath).arrayBuffer()),
        catch: (e) => e as Error,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (coverBuffer) {
        yield* Effect.tryPromise({
          try: () => saveBufferAsImage(coverBuffer, coverPath, COVER_MAX_SIZE),
          catch: (e) => e as Error,
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));
        return;
      }
    }

    const embeddedCover = yield* Effect.tryPromise({
      try: () => extractEmbeddedCover(audioFilePath),
      catch: () => null,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));

    if (embeddedCover) {
      yield* Effect.tryPromise({
        try: () => saveBufferAsImage(embeddedCover.data, coverPath, COVER_MAX_SIZE),
        catch: (e) => e as Error,
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));
    }
  }).pipe(Effect.catchAll(() => Effect.void));
