import type { LiveHandle, LiveStatus, PassAdmission } from "@seigiard/sync-engine";
import { Cause, Effect } from "effect";
import { join, relative } from "node:path";
import { log } from "../logging/index.ts";
import type { RawBooksEvent } from "../effect/types.ts";
import type { HandlerDeps } from "../context.ts";
import { startEpisodeSynchronization, type EpisodeSynchronizationOptions } from "./composition.ts";
import type { OpmlEngineWork } from "./work.ts";
import { OPML_FILE } from "../constants.ts";

const firstLine = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split("\n")[0] ?? "";

type Session = LiveHandle<OpmlEngineWork, unknown>;

const STOPPED: LiveStatus<OpmlEngineWork> = {
  state: "stopped",
  pass: null,
  followUp: null,
  failure: null,
  availability: null,
  work: { state: "stopped", pending: 0, active: null, errors: [] },
};

interface EpisodeEngineStatus extends Omit<LiveStatus<OpmlEngineWork>, "availability"> {
  readonly available: boolean;
  readonly availableFrom: "prior-output" | "minimum-publication" | null;
  readonly verifying: boolean;
  readonly completed: boolean;
  readonly errors: readonly { readonly source: "work" | "pass"; readonly message: string }[];
}

export interface EpisodeEngineRuntime {
  readonly ready: Promise<void>;

  readonly status: () => Promise<EpisodeEngineStatus>;

  readonly notifyBooksEvent: (event: RawBooksEvent) => Promise<PassAdmission>;

  readonly requestPass: (force?: boolean) => Promise<PassAdmission>;

  readonly stop: () => Promise<void>;
}

export function startEpisodeEngineRuntime(deps: HandlerDeps): EpisodeEngineRuntime {
  const controller = new AbortController();

  const session = Promise.withResolvers<Session>();

  const ready = Promise.withResolvers<void>();
  const hadPriorOutput = Bun.file(join(deps.config.dataPath, OPML_FILE)).exists();

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

  const notify = async (relativePaths: readonly string[]): Promise<PassAdmission> => {
    if (controller.signal.aborted) return "rejected";
    const live = await session.promise.catch(() => undefined);

    return live ? Effect.runPromise(live.notify(relativePaths)) : "queued";
  };

  const availableFrom = async (status: LiveStatus<OpmlEngineWork>) => {
    if (!(await Bun.file(join(deps.config.dataPath, OPML_FILE)).exists())) return null;

    return status.availability ?? ((await hadPriorOutput) ? "prior-output" : "minimum-publication");
  };

  return {
    ready: ready.promise,
    status: async () => {
      const live = await session.promise.catch(() => undefined);
      const engine = live ? await Effect.runPromise(live.status) : STOPPED;
      const from = await availableFrom(engine);

      const verifying =
        engine.state === "working" || engine.pass !== null || engine.followUp !== null;

      const settled = engine.state === "complete" || engine.state === "complete-with-errors";

      const errors = [
        ...engine.work.errors.map((error) => ({
          source: "work" as const,
          message: firstLine(error.cause),
        })),
        ...(engine.failure
          ? [{ source: "pass" as const, message: firstLine(engine.failure) }]
          : []),
      ];

      return {
        state: engine.state,
        pass: engine.pass,
        followUp: engine.followUp,
        failure: engine.failure,
        work: engine.work,
        available: from !== null,
        availableFrom: from,
        verifying,
        completed: settled && !verifying,
        errors,
      };
    },
    notifyBooksEvent: async (event) => {
      const path = relative(deps.config.filesPath, `${event.parent}/${event.name}`);

      return notify([path]);
    },
    requestPass: async (force = false) => {
      if (controller.signal.aborted) return "rejected";
      const live = await session.promise.catch(() => undefined);

      return live ? Effect.runPromise(live.requestPass({ force })) : "queued";
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
