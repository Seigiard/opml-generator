import { Effect } from "effect";
import { dirname, join, relative } from "node:path";
import { ConfigService, LoggerService, FileSystemService } from "../services.ts";
import type { EventType } from "../types.ts";

export const audioCleanup = (
  event: EventType,
): Effect.Effect<readonly EventType[], Error, ConfigService | LoggerService | FileSystemService> =>
  Effect.gen(function* () {
    if (event._tag !== "AudioFileDeleted") return [];
    const { parent, name } = event;
    const config = yield* ConfigService;
    const logger = yield* LoggerService;
    const fs = yield* FileSystemService;

    const filePath = join(parent, name);
    const relativePath = relative(config.filesPath, filePath);
    const dataDir = join(config.dataPath, relativePath);

    yield* logger.info("AudioCleanup", "Removing", { path: relativePath });

    yield* fs.rm(dataDir, { recursive: true }).pipe(
      Effect.catchAll((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return logger.debug("AudioCleanup", "Already removed", { path: relativePath });
        }
        return Effect.fail(error);
      }),
    );

    yield* logger.info("AudioCleanup", "Done", { path: relativePath });

    const parentDataDir = dirname(dataDir);
    return [{ _tag: "FolderMetaSyncRequested", path: parentDataDir }] as const;
  });
