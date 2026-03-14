import { describe, test, expect } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { HandlerRegistry, LiveLayer } from "../../../src/effect/services.ts";
import type { EffectHandler, AsyncHandler, UnifiedHandler } from "../../../src/effect/services.ts";
import type { EventType } from "../../../src/effect/types.ts";
import { ok, err } from "neverthrow";

describe("UnifiedHandler adapter", () => {
  test("registerEffect stores handler with kind 'effect'", async () => {
    // #given
    const runtime = ManagedRuntime.make(LiveLayer);
    const effectHandler: EffectHandler = () => Effect.succeed([] as readonly EventType[]);

    // #when
    const kind = await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* HandlerRegistry;
        registry.registerEffect("TestEffect", effectHandler);
        const stored = registry.get("TestEffect");
        return stored?.kind;
      }),
    );

    // #then
    expect(kind).toBe("effect");
    await runtime.dispose();
  });

  test("registerAsync stores handler with kind 'async'", async () => {
    // #given
    const runtime = ManagedRuntime.make(LiveLayer);
    const asyncHandler: AsyncHandler = async () => ok([]);

    // #when
    const kind = await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* HandlerRegistry;
        registry.registerAsync("TestAsync", asyncHandler);
        const stored = registry.get("TestAsync");
        return stored?.kind;
      }),
    );

    // #then
    expect(kind).toBe("async");
    await runtime.dispose();
  });

  test("effect handler produces cascade events", async () => {
    // #given
    const cascadeEvent: EventType = { _tag: "FolderMetaSyncRequested", path: "/test" };
    const effectHandler: EffectHandler = () => Effect.succeed([cascadeEvent] as readonly EventType[]);

    const unified: UnifiedHandler = { kind: "effect", handler: effectHandler };

    // #when — run through the Effect runtime with layers
    const runtime = ManagedRuntime.make(LiveLayer);
    const cascades = await runtime.runPromise(
      unified.kind === "effect"
        ? unified.handler({ _tag: "AudioFileCreated", parent: "/a", name: "b.mp3" })
        : Effect.succeed([] as readonly EventType[]),
    );

    // #then
    expect(cascades).toHaveLength(1);
    expect(cascades[0]!._tag).toBe("FolderMetaSyncRequested");
    await runtime.dispose();
  });

  test("async handler returns ok Result with cascades", async () => {
    // #given
    const cascadeEvent: EventType = { _tag: "FolderMetaSyncRequested", path: "/test" };
    const asyncHandler: AsyncHandler = async () => ok([cascadeEvent]);
    const deps = mockDeps();

    // #when
    const result = await asyncHandler({ _tag: "AudioFileCreated", parent: "/a", name: "b.mp3" }, deps);

    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    expect(result._unsafeUnwrap()[0]!._tag).toBe("FolderMetaSyncRequested");
  });

  test("async handler returns err Result on failure", async () => {
    // #given
    const asyncHandler: AsyncHandler = async () => err(new Error("test error"));
    const deps = mockDeps();

    // #when
    const result = await asyncHandler({ _tag: "AudioFileCreated", parent: "/a", name: "b.mp3" }, deps);

    // #then
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe("test error");
  });

  test("get returns undefined for unregistered tag", async () => {
    // #given
    const runtime = ManagedRuntime.make(LiveLayer);

    // #when
    const stored = await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* HandlerRegistry;
        return registry.get("NonExistent");
      }),
    );

    // #then
    expect(stored).toBeUndefined();
    await runtime.dispose();
  });
});

function mockDeps() {
  return {
    config: { filesPath: "/f", dataPath: "/d", port: 3000, reconcileInterval: 1800 },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fs: {
      mkdir: async () => {},
      rm: async () => {},
      readdir: async () => [] as string[],
      stat: async () => ({ isDirectory: () => false as const, size: 0 }),
      exists: async () => false,
      writeFile: async () => {},
      atomicWrite: async () => {},
      symlink: async () => {},
      unlink: async () => {},
    },
  };
}
