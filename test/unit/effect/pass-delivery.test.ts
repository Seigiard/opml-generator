import { expect, test } from "bun:test";
import { buildContext } from "../../../src/context.ts";
import type { PassScopedEvent } from "../../../src/effect/types.ts";

test.each([
  ["old active", true],
  ["covered pending", false],
] as const)("an error in %s belongs only to that delivered occurrence", async (fault, expected) => {
  // #given
  const { queue, lifecycle } = await buildContext();
  const folder = { _tag: "FolderMetaSyncRequested", path: "/data/Book" } as const;
  queue.enqueue({ ...folder });
  const old = await queue.take();
  queue.enqueue({ ...folder });
  const passId = lifecycle.startPass();
  lifecycle.enqueue(queue, folder, passId);

  const pass = lifecycle.waitFor(passId).then(
    () => true,
    () => false,
  );

  // #when
  lifecycle.complete(
    old,
    fault === "old active" ? new Error("old ordinary operation failed") : undefined,
  );
  queue.complete();
  const covered = await queue.take();
  lifecycle.complete(
    covered,
    fault === "covered pending" ? new Error("covered operation failed") : undefined,
  );
  queue.complete();

  // #then
  expect(await pass).toBe(expected);
});

test.each([
  ["direct", "take"],
  ["adopted", "take"],
  ["direct", "resume"],
  ["adopted", "resume"],
])(
  "%s covered delivery retains its position through %s and leaves later hints ordinary",
  async (ownership, delivery) => {
    // #given
    const { queue, lifecycle } = await buildContext();
    const passId = lifecycle.startPass();
    const folder = { _tag: "FolderMetaSyncRequested", path: "/data/Book" } as const;

    if (ownership === "adopted") queue.enqueue(folder);
    lifecycle.enqueue(queue, folder, passId);
    queue.enqueue({ _tag: "AudioFileCreated", parent: "/books", name: "later.mp3" });
    queue.enqueue(folder);
    const pass = lifecycle.waitFor(passId);

    // #when
    let first: PassScopedEvent;

    if (delivery === "resume") {
      await queue.pause();
      const waiting = queue.take();
      queue.resume();
      first = await waiting;
    } else {
      first = await queue.take();
    }

    lifecycle.complete(first);
    queue.complete();
    // Report the wrong first delivery without waiting forever for the covered event.
    expect(first._tag).toBe("FolderMetaSyncRequested");
    await pass;
    const later = await queue.take();
    queue.complete();
    const followup = await queue.take();
    queue.complete();

    // #then
    expect({
      first: first._tag,
      later: later._tag,
      followup,
      remaining: queue.size,
    }).toEqual({
      first: "FolderMetaSyncRequested",
      later: "AudioFileCreated",
      followup: { _tag: "FolderMetaSyncRequested", path: "/data/Book" },
      remaining: 0,
    });
  },
);
