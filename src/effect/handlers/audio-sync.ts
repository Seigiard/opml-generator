import { Effect } from "effect";
import { join, basename, relative } from "node:path";
import { Entry } from "opds-ts/v1.2";
import { MIME_TYPES } from "../../types.ts";
import { getHandlerFactory } from "../../formats/index.ts";
import type { BookMetadata } from "../../formats/types.ts";
import { saveBufferAsImage, COVER_MAX_SIZE, THUMBNAIL_MAX_SIZE } from "../../utils/image.ts";
import { encodeUrlPath, formatFileSize, normalizeFilenameTitle } from "../../utils/processor.ts";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";
import { ENTRY_FILE, COVER_FILE, THUMB_FILE } from "../../constants.ts";

export const audioSync = (event: EventType): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "AudioFileCreated") return [];
    const { parent, name } = event;
    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;

    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const filePath = join(parent, name);
    const relativePath = relative(config.filesPath, filePath);
    const bookDataDir = join(config.dataPath, relativePath);

    yield* logger.info("AudioSync", "Processing", { path: relativePath });

    // Get file stats via DI
    const fileStat = yield* fs.stat(filePath);

    // Create data directory
    yield* fs.mkdir(bookDataDir, { recursive: true });

    // Extract metadata
    const createHandler = getHandlerFactory(ext);
    const rawFilename = basename(relativePath).replace(/\.[^.]+$/, "");
    let title = normalizeFilenameTitle(rawFilename);
    let author: string | undefined;
    let description: string | undefined;
    let hasCover = false;

    let meta: BookMetadata = { title: "" };

    if (createHandler) {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const handler = await createHandler(filePath);
          if (handler) {
            const m = handler.getMetadata();
            const cover = await handler.getCover();
            return { metadata: m, cover };
          }
          return null;
        },
        catch: (e) => e as Error,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (result) {
        meta = result.metadata;
        if (meta.title) title = meta.title;
        author = meta.author;
        description = meta.description;

        if (result.cover) {
          const coverPath = join(bookDataDir, COVER_FILE);
          const thumbPath = join(bookDataDir, THUMB_FILE);

          const coverOk = yield* Effect.tryPromise({
            try: () => saveBufferAsImage(result.cover!, coverPath, COVER_MAX_SIZE),
            catch: (e) => e as Error,
          }).pipe(Effect.catchAll(() => Effect.succeed(false)));

          if (coverOk) {
            yield* Effect.tryPromise({
              try: () => saveBufferAsImage(result.cover!, thumbPath, THUMBNAIL_MAX_SIZE),
              catch: (e) => e as Error,
            }).pipe(Effect.catchAll(() => Effect.succeed(false)));
            hasCover = true;
          }
        }
      }
    }

    // Build OPDS entry
    const encodedPath = encodeUrlPath(relativePath);
    const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";

    const entry = new Entry(`urn:opds:book:${relativePath}`, title);
    if (author) entry.setAuthor(author);
    if (description) entry.setSummary(description);
    entry.setDcMetadataField("format", ext.toUpperCase());
    entry.setContent({ type: "text", value: formatFileSize(fileStat.size) });

    if (meta.publisher) entry.setDcMetadataField("publisher", meta.publisher);
    if (meta.issued) entry.setDcMetadataField("issued", meta.issued);
    if (meta.language) entry.setDcMetadataField("language", meta.language);
    if (meta.subjects) entry.setDcMetadataField("subjects", meta.subjects);
    if (meta.pageCount) entry.setDcMetadataField("extent", `${meta.pageCount} pages`);
    if (meta.series) entry.setDcMetadataField("isPartOf", meta.series);
    if (meta.rights) entry.setRights(meta.rights);

    if (hasCover) {
      entry.addImage(`/${encodedPath}/cover.jpg`);
      entry.addThumbnail(`/${encodedPath}/thumb.jpg`);
    }

    const encodedFilename = encodeURIComponent(name);
    entry.addAcquisition(`/${encodedPath}/${encodedFilename}`, mimeType, "open-access");

    // Write entry.xml (atomic)
    const entryXml = entry.toXml({ prettyPrint: true });
    yield* fs.atomicWrite(join(bookDataDir, ENTRY_FILE), entryXml);

    // Create symlink to original file (using original filename for correct download name)
    yield* fs.symlink(filePath, join(bookDataDir, name));

    yield* logger.info("AudioSync", "Done", { path: relativePath, has_cover: hasCover });

    return [];
  });
