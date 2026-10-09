import {
  openLiveSynchronization,
  startLiveSynchronization,
  type LiveOptions,
  type PassRequest,
  type SourceEntry,
} from "@seigiard/sync-engine";
import { Effect } from "effect";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { AUDIO_EXTENSIONS } from "../types.ts";
import type { HandlerDeps } from "../context.ts";
import { audioSync } from "../effect/handlers/audio-sync.ts";
import { audioCleanup } from "../effect/handlers/audio-cleanup.ts";
import { folderCleanup } from "../effect/handlers/folder-cleanup.ts";
import { folderMetaSync } from "../effect/handlers/folder-meta-sync.ts";
import { publishOpml } from "../effect/handlers/opml-sync.ts";
import { sourcePathSync } from "../effect/handlers/source-path-sync.ts";
import type { EventType } from "../effect/types.ts";
import { ENTRY_FILE, FEED_FILE, FOLDER_ENTRY_FILE, OPML_FILE } from "../constants.ts";
import { cacheMirrors } from "../cache-mirrors.ts";
import { cachePath, decodeRelative } from "../cache-projection.ts";
import { readSourceEntry } from "../effect/handlers/source-kind.ts";
import { opmlEngineStatePath } from "./policy.ts";
import {
  EpisodeDeleteWork,
  EpisodeWork,
  FolderDeleteWork,
  FolderWork,
  failureKey,
  type OpmlEngineWork,
  workKey,
} from "./work.ts";

export interface EpisodeSynchronizationOptions extends HandlerDeps {
  /** Zero disables the engine's periodic reconciliation. */
  readonly reconcileIntervalMs: number;

  readonly processingVersions?: { readonly episode?: string; readonly folder?: string };

  readonly beforeFolderWork?: (work: FolderWork) => Effect.Effect<void, Error>;
}

const supported = new Set(AUDIO_EXTENSIONS.map((extension) => `.${extension}`));

const EPISODE_PROCESSING_VERSION = "1";

const FOLDER_PROCESSING_VERSION = "1";

function audioEntries(entries: readonly SourceEntry[]): EpisodeWork[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== "file") return [];

    if (!supported.has(extname(entry.path).toLowerCase())) return [];

    return [new EpisodeWork(entry.path)];
  });
}

async function obsoleteEpisodeEntries(
  entries: readonly SourceEntry[],
  deps: HandlerDeps,
  deletedFolders: readonly FolderDeleteWork[],
): Promise<EpisodeDeleteWork[]> {
  const present = new Set(audioEntries(entries).map((entry) => entry.relativePath));
  const deleted: EpisodeDeleteWork[] = [];
  const deletedFolderPaths = deletedFolders.map((work) => work.relativePath);

  await collectObsoleteEpisodes(deps.config.dataPath, deps, present, deleted);

  return deleted.filter(
    (work) =>
      !deletedFolderPaths.some(
        (folder) => work.relativePath === folder || work.relativePath.startsWith(`${folder}/`),
      ),
  );
}

function sourceFolderEntries(entries: readonly SourceEntry[], deps: HandlerDeps): FolderWork[] {
  const folders = new Set<string>([deps.config.dataPath]);

  for (const entry of audioEntries(entries)) {
    let folder = dirname(entry.relativePath);

    folders.add(cachePath(deps.config.dataPath, folder === "." ? "" : folder));

    while (folder !== "." && folder !== "") {
      folder = dirname(folder);
      folders.add(cachePath(deps.config.dataPath, folder === "." ? "" : folder));
    }
  }

  return [...folders]
    .sort(
      (a, b) =>
        relative(deps.config.dataPath, b).split("/").length -
        relative(deps.config.dataPath, a).split("/").length,
    )
    .map((path) => new FolderWork(path));
}

async function cachedFolderDeletes(
  entries: readonly SourceEntry[],
  deps: HandlerDeps,
): Promise<FolderDeleteWork[]> {
  const currentFolders = new Set(
    sourceFolderEntries(entries, deps).map((work) => resolve(work.dataPath)),
  );
  const deleted: FolderDeleteWork[] = [];

  await collectCachedFolderDeletes(deps.config.dataPath, deps, currentFolders, deleted);

  return deleted;
}

async function collectCachedFolderDeletes(
  dir: string,
  deps: HandlerDeps,
  currentFolders: ReadonlySet<string>,
  deleted: FolderDeleteWork[],
): Promise<void> {
  for (const { path } of await cacheMirrors(dir, deps.config.dataPath, deps.fs))
    await collectCachedFolderDeletes(path, deps, currentFolders, deleted);

  if (resolve(dir) === resolve(deps.config.dataPath)) return;

  if ((await Bun.file(join(dir, FEED_FILE)).exists()) && !currentFolders.has(resolve(dir)))
    deleted.push(
      new FolderDeleteWork(decodeRelative(relative(resolve(deps.config.dataPath), resolve(dir)))),
    );
}

async function collectObsoleteEpisodes(
  dir: string,
  deps: HandlerDeps,
  present: ReadonlySet<string>,
  deleted: EpisodeDeleteWork[],
): Promise<void> {
  if (await Bun.file(join(dir, ENTRY_FILE)).exists()) {
    const relativePath = decodeRelative(relative(deps.config.dataPath, dir));

    if (!present.has(relativePath)) deleted.push(new EpisodeDeleteWork(relativePath));

    return;
  }

  for (const { path } of await cacheMirrors(dir, deps.config.dataPath, deps.fs))
    await collectObsoleteEpisodes(path, deps, present, deleted);
}

export async function workFromCascade(
  event: EventType,
  deps: HandlerDeps,
): Promise<OpmlEngineWork[]> {
  switch (event._tag) {
    case "AudioFileCreated":
      return [new EpisodeWork(relative(deps.config.filesPath, join(event.parent, event.name)))];
    case "AudioFileDeleted":
      return [
        new EpisodeDeleteWork(relative(deps.config.filesPath, join(event.parent, event.name))),
      ];
    case "FolderDeleted":
      return [
        new FolderDeleteWork(relative(deps.config.filesPath, join(event.parent, event.name))),
      ];
    case "FolderMetaSyncRequested":
      return [new FolderWork(event.path)];
    case "SourcePathSyncRequested": {
      const result = await sourcePathSync(event, deps);

      if (result.isErr()) throw result.error;

      const settled = await Promise.allSettled(
        result.value.map((cascade) => workFromCascade(cascade, deps)),
      );
      const rejected = settled.find((item) => item.status === "rejected");

      if (rejected) throw rejected.reason;

      return settled.flatMap((item) => (item.status === "fulfilled" ? item.value : []));
    }

    default:
      return [];
  }
}

async function runHandler(
  run: () => Promise<import("neverthrow").Result<readonly EventType[], Error>>,
  deps: HandlerDeps,
): Promise<readonly OpmlEngineWork[]> {
  const result = await run();

  if (result.isErr()) throw result.error;

  return (await Promise.all(result.value.map((event) => workFromCascade(event, deps)))).flat();
}

async function assertSourceRootDirectory(deps: HandlerDeps): Promise<void> {
  const sourceRoot = await readSourceEntry(deps.config.filesPath, deps.config.filesPath, deps.fs);

  if (sourceRoot.kind !== "directory")
    throw new Error(`Source root is not a directory: ${deps.config.filesPath}`);
}

function handleEpisode(
  work: OpmlEngineWork,
  options: EpisodeSynchronizationOptions,
): Effect.Effect<readonly OpmlEngineWork[], Error> {
  return Effect.tryPromise({
    try: async () => {
      if (work._tag === "FolderWork") {
        if (options.beforeFolderWork) await Effect.runPromise(options.beforeFolderWork(work));

        return runHandler(
          () => folderMetaSync({ _tag: "FolderMetaSyncRequested", path: work.dataPath }, options),
          options,
        );
      }

      const sourcePath = join(options.config.filesPath, work.relativePath);
      const event = { parent: dirname(sourcePath), name: basename(sourcePath) };

      if (work._tag === "FolderDeleteWork") {
        return runHandler(
          () => folderCleanup({ _tag: "FolderDeleted", ...event }, options),
          options,
        );
      }

      if (work._tag === "EpisodeDeleteWork") {
        return runHandler(
          () => audioCleanup({ _tag: "AudioFileDeleted", ...event }, options),
          options,
        );
      }

      return runHandler(() => audioSync({ _tag: "AudioFileCreated", ...event }, options), options);
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.uninterruptible);
}

function publishFinalOpml(options: HandlerDeps): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      await assertSourceRootDirectory(options);

      const result = await publishOpml(options);

      if (result.isErr()) throw result.error;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.uninterruptible);
}

function folderRelativePath(work: FolderWork, dataPath: string): string {
  return decodeRelative(relative(dataPath, work.dataPath));
}

function outputRelativePath(dataPath: string, ...parts: readonly string[]): string {
  return relative(dataPath, join(...parts));
}

function episodeLiveOptions(
  options: EpisodeSynchronizationOptions,
): LiveOptions<OpmlEngineWork, Error, never> {
  return {
    sourcePath: options.config.filesPath,
    outputPath: options.config.dataPath,
    statePath: opmlEngineStatePath(options.config.dataPath),
    reconcileIntervalMs: options.reconcileIntervalMs,
    handle: (work) => handleEpisode(work, options),
    key: workKey,
    failureKey,
    freshness: {
      check: "metadata",
      describe: (work) => {
        if (work._tag === "EpisodeWork") {
          return {
            sourcePaths: [work.relativePath],
            resultKind: "episode",
            processingVersion: options.processingVersions?.episode ?? EPISODE_PROCESSING_VERSION,
            outputPaths: [
              outputRelativePath(
                options.config.dataPath,
                cachePath(options.config.dataPath, work.relativePath),
                ENTRY_FILE,
              ),
            ],
          };
        }

        if (work._tag === "FolderWork") {
          const sourcePath = folderRelativePath(work, options.config.dataPath);

          const outputPaths = [
            outputRelativePath(options.config.dataPath, work.dataPath, FEED_FILE),
          ];

          if (sourcePath !== "")
            outputPaths.push(
              outputRelativePath(options.config.dataPath, work.dataPath, FOLDER_ENTRY_FILE),
            );

          return {
            sourcePaths: [sourcePath],
            resultKind: "folder",
            processingVersion: options.processingVersions?.folder ?? FOLDER_PROCESSING_VERSION,
            outputPaths,
          };
        }

        return undefined;
      },
    },
    recovery: {
      existing: Effect.promise(() =>
        Bun.file(join(options.config.dataPath, OPML_FILE)).exists(),
      ).pipe(Effect.orElseSucceed(() => false)),
    },
    declare: (entries, _request: PassRequest) =>
      Effect.tryPromise({
        try: async () => {
          const folderDeletes = await cachedFolderDeletes(entries, options);

          return {
            work: [
              ...folderDeletes,
              ...(await obsoleteEpisodeEntries(entries, options, folderDeletes)),
              ...audioEntries(entries),
              ...sourceFolderEntries(entries, options),
            ],
            publish: publishFinalOpml(options),
          };
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
  };
}

export function startEpisodeSynchronization(options: EpisodeSynchronizationOptions) {
  return startLiveSynchronization(episodeLiveOptions(options));
}

export function openEpisodeSynchronization(options: EpisodeSynchronizationOptions) {
  return openLiveSynchronization(episodeLiveOptions(options));
}
