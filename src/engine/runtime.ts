import { Cause, Effect } from "effect";
import { relative } from "node:path";
import { log } from "../logging/index.ts";
import type { RawBooksEvent } from "../effect/types.ts";
import type { HandlerDeps } from "../context.ts";
import { startEpisodeSynchronization, type EpisodeSynchronizationOptions } from "./composition.ts";

const firstLine = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n")[0] ?? "";

export interface EpisodeEngineRuntime {
  readonly ready: Promise<void>;

  readonly isReady: () => boolean;

  readonly notifyBooksEvent: (event: RawBooksEvent) => Promise<void>;

  readonly requestPass: (force?: boolean) => Promise<void>;

  readonly stop: () => Promise<void>;
}

export function startEpisodeEngineRuntime(deps: HandlerDeps): EpisodeEngineRuntime {
  const controller = new AbortController();

  const session =
    Promise.withResolvers<Effect.Success<ReturnType<typeof startEpisodeSynchronization>>>();

  const ready = Promise.withResolvers<void>();

  let readyState = false;

  session.promise.catch(() => undefined);
  ready.promise.catch(() => undefined);

  const options: EpisodeSynchronizationOptions = {
    ...deps,
    reconcileIntervalMs: deps.config.reconcileInterval * 1000,
  };

  const running = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* startEpisodeSynchronization(options);
        session.resolve(live);
        yield* live.ready;
        readyState = true;
        ready.resolve();
        yield* Effect.never;
      }),
    ),
    { signal: controller.signal },
  ).catch((cause: unknown) => {
    session.reject(cause);
    ready.reject(cause);

    if (!controller.signal.aborted) log.error("Engine", "Episode synchronization failed", cause);
  });

  const notify = async (relativePaths: readonly string[]) => {
    if (controller.signal.aborted) return;
    const live = await session.promise.catch(() => undefined);

    if (live) await Effect.runPromise(live.notify(relativePaths));
  };

  return {
    ready: ready.promise,
    isReady: () => readyState,
    notifyBooksEvent: async (event) => {
      const path = relative(deps.config.filesPath, `${event.parent}/${event.name}`);
      await notify([path]);
    },
    requestPass: async (force = false) => {
      if (controller.signal.aborted) return;
      const live = await session.promise.catch(() => undefined);

      if (live) await Effect.runPromise(live.requestPass({ force }));
    },
    stop: async () => {
      controller.abort();
      await running;
    },
  };
}

export function logEpisodeEngineReadyFailure(error: Error | Cause.Cause<unknown>): void {
  if (Cause.isCause(error)) {
    log.error("Engine", "Episode synchronization failed before ready", new Error(firstLine(error)));

    return;
  }

  log.error("Engine", "Episode synchronization failed before ready", error);
}
