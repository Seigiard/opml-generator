import {
  openLiveSynchronization,
  startLiveSynchronization,
  type LiveOptions,
  type SourceEntry,
} from "@seigiard/sync-engine";
import { Effect } from "effect";
import { basename, dirname, extname, join } from "node:path";
import { AUDIO_EXTENSIONS } from "../types.ts";
import type { HandlerDeps } from "../context.ts";
import { audioSync } from "../effect/handlers/audio-sync.ts";
import { opmlEngineStatePath } from "./policy.ts";
import { EpisodeWork, type OpmlEngineWork, workKey } from "./work.ts";

export interface EpisodeSynchronizationOptions extends HandlerDeps {
  /** Zero disables the engine's periodic reconciliation. */
  readonly reconcileIntervalMs: number;
}

const supported = new Set(AUDIO_EXTENSIONS.map((extension) => `.${extension}`));

function audioEntries(entries: readonly SourceEntry[]): EpisodeWork[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== "file") return [];

    if (!supported.has(extname(entry.path).toLowerCase())) return [];

    return [new EpisodeWork(entry.path)];
  });
}

function handleEpisode(
  work: OpmlEngineWork,
  deps: HandlerDeps,
): Effect.Effect<readonly OpmlEngineWork[], Error> {
  return Effect.tryPromise({
    try: async () => {
      const sourcePath = join(deps.config.filesPath, work.relativePath);

      const result = await audioSync(
        { _tag: "AudioFileCreated", parent: dirname(sourcePath), name: basename(sourcePath) },
        deps,
      );

      if (result.isErr()) throw result.error;

      return [];
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

/** Episode-only temporary composition for #61. RSS and final OPML publication stay on the legacy path until #62. */
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
    failureKey: workKey,
    declare: (entries) => Effect.succeed({ work: audioEntries(entries), publish: Effect.void }),
  };
}

export function startEpisodeSynchronization(options: EpisodeSynchronizationOptions) {
  return startLiveSynchronization(episodeLiveOptions(options));
}

export function openEpisodeSynchronization(options: EpisodeSynchronizationOptions) {
  return openLiveSynchronization(episodeLiveOptions(options));
}
