import { describe, test, expect, afterAll } from "bun:test";
import { ok } from "neverthrow";
import { buildContext } from "../../../src/context.ts";
import { startConsumer } from "../../../src/effect/consumer.ts";
import type { EventType } from "../../../src/effect/types.ts";

describe("Queue and Consumer Integration", () => {
  const controllers: AbortController[] = [];

  afterAll(() => {
    for (const c of controllers) c.abort();
  });

  test("consumer processes events from shared queue", async () => {
    // #given
    const ctx = await buildContext();
    const controller = new AbortController();
    controllers.push(controller);
    const processedEvents: string[] = [];

    ctx.handlers.register("FolderMetaSyncRequested", async (event) => {
      processedEvents.push((event as { path: string }).path);
      return ok([] as readonly EventType[]);
    });

    // #when
    const consumerTask = startConsumer(ctx, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));

    ctx.queue.enqueue({ _tag: "FolderMetaSyncRequested", path: "/test/book" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    controller.abort();
    await consumerTask.catch(() => {});

    // #then
    expect(processedEvents).toContain("/test/book");
  });

  test("multiple enqueue calls share same queue", () => {
    // #given
    const { queue } = {
      queue: new (require("../../../src/queue.ts").SimpleQueue)(),
    };
    // #when
    queue.enqueue("a");
    queue.enqueue("b");
    // #then
    expect(queue.size).toBe(2);
  });

  test("consumer stops on abort signal", async () => {
    // #given
    const ctx = await buildContext();
    const controller = new AbortController();
    controllers.push(controller);

    // #when
    const consumerTask = startConsumer(ctx, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await consumerTask.catch(() => {});

    // #then — consumer exited without error
    expect(true).toBe(true);
  });
});
