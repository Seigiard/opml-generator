/**
 * Queue and Consumer integration tests.
 *
 * Historical context (see git history for full documentation tests):
 * - ManagedRuntime vs Effect.provide bug: each provide() creates new queue
 * - Effect.ensuring guarantees cleanup even on error
 * - EBUSY race conditions on directory deletion when nginx holds it open
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Effect, Fiber, ManagedRuntime } from "effect";
import { LiveLayer, EventQueueService, HandlerRegistry } from "../../../src/effect/services.ts";
import { startConsumer } from "../../../src/effect/consumer.ts";
import type { EventType } from "../../../src/effect/types.ts";

describe("Queue and Consumer Integration", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    typeof LiveLayer extends import("effect").Layer.Layer<infer R, infer _E, infer _A> ? R : never,
    never
  >;
  let consumerFiber: Fiber.RuntimeFiber<never, Error>;

  beforeAll(async () => {
    runtime = ManagedRuntime.make(LiveLayer);
  });

  afterAll(async () => {
    if (consumerFiber) {
      await runtime.runPromise(Fiber.interrupt(consumerFiber));
    }
    await runtime.dispose();
  });

  test("consumer processes events from shared queue", async () => {
    const processedEvents: string[] = [];

    // Register a test handler that tracks processed events
    await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* HandlerRegistry;
        registry.registerEffect("FolderMetaSyncRequested", (event: EventType) =>
          Effect.sync(() => {
            processedEvents.push((event as { path: string }).path);
            return [] as readonly EventType[];
          }),
        );
      }),
    );

    // Start consumer in background
    consumerFiber = runtime.runFork(startConsumer);

    // Give consumer time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Queue a test event
    await runtime.runPromise(
      Effect.gen(function* () {
        const queue = yield* EventQueueService;
        yield* queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/test/book.epub" });
      }),
    );

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify event was processed
    expect(processedEvents).toContain("/test/book.epub");
  });

  test("multiple Effect.provide calls with same runtime share queue", async () => {
    // This test verifies that we don't have the bug where each Effect.provide
    // creates a new queue instance
    // We use a separate runtime without consumer to isolate this test

    const isolatedRuntime = ManagedRuntime.make(LiveLayer);

    let queueSize1 = -1;
    let queueSize2 = -1;

    // First call - enqueue an event
    await isolatedRuntime.runPromise(
      Effect.gen(function* () {
        const queue = yield* EventQueueService;
        yield* queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/shared/test1.epub" });
        queueSize1 = yield* queue.size();
      }),
    );

    // Second call - check queue size (should include the event from first call)
    await isolatedRuntime.runPromise(
      Effect.gen(function* () {
        const queue = yield* EventQueueService;
        queueSize2 = yield* queue.size();
      }),
    );

    // Both calls should see the same queue - size should be identical
    expect(queueSize1).toBe(1);
    expect(queueSize2).toBe(1); // Same queue = same size

    await isolatedRuntime.dispose();
  });
});
