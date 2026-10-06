import { afterEach, expect, spyOn, test } from "bun:test";
import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import { ApplicationLifecycle } from "../../../src/app-lifecycle.ts";
import { buildContext } from "../../../src/context.ts";
import { registerHandlers } from "../../../src/effect/handlers/index.ts";
import { createTempDir } from "../../helpers/fs-helpers.ts";

function gate() {
  let open!: () => void;

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each(["source readdir", "source stat", "cache readdir", "cache stat"])(
  "shutdown after awaited %s stops the scan before its next real filesystem operation",
  async (operation) => {
    // #given
    const root = await createTempDir("scan-stopping");
    const filesPath = join(root, "books");
    const dataPath = join(root, "data");
    await filesystem.mkdir(join(filesPath, "Author/Book"), { recursive: true });
    await filesystem.mkdir(dataPath);
    await Bun.write(
      join(filesPath, "Author/Book/01.mp3"),
      Bun.file("test/fixtures/audio/untagged.mp3"),
    );
    await Bun.write(
      join(filesPath, "Author/Book/02.mp3"),
      Bun.file("test/fixtures/audio/untagged.mp3"),
    );
    const base = await buildContext();
    const ctx = { ...base, config: { ...base.config, filesPath, dataPath } };
    registerHandlers(ctx.handlers);
    const seed = new ApplicationLifecycle(ctx);
    seed.startProcessing();
    cleanups.push(async () => {
      await seed.shutdown();
      await filesystem.rm(root, { recursive: true });
    });
    expect(await seed.runInitialSync()).toBe(true);
    const previous = await Bun.file(join(dataPath, "feed.opml")).text();
    const app = new ApplicationLifecycle(ctx);
    const entered = gate();
    const release = gate();
    const read = filesystem.readdir;
    const stat = filesystem.stat;
    const laterOperations: string[] = [];
    let held = false;

    // SAFETY: this transparent wrapper forwards every option to the real readdir overload.
    const readSpy = spyOn(filesystem, "readdir").mockImplementation((async (
      path: Parameters<typeof filesystem.readdir>[0],
      options?: Parameters<typeof filesystem.readdir>[1],
    ) => {
      if (held) laterOperations.push(`readdir:${path}`);
      const result = options === undefined ? await read(path) : await read(path, options);

      if (
        !held &&
        ((operation === "source readdir" && path === filesPath) ||
          (operation === "cache readdir" && path === dataPath))
      ) {
        held = true;
        entered.open();
        await release.promise;
      }

      return result;
    }) as typeof filesystem.readdir);

    // SAFETY: this transparent wrapper forwards every option to the real stat overload.
    const statSpy = spyOn(filesystem, "stat").mockImplementation((async (
      path: Parameters<typeof filesystem.stat>[0],
      options?: Parameters<typeof filesystem.stat>[1],
    ) => {
      if (held) laterOperations.push(`stat:${path}`);
      const result = await stat(path, options);

      if (
        !held &&
        ((operation === "source stat" && path === join(filesPath, "Author/Book/01.mp3")) ||
          (operation === "cache stat" && path === join(dataPath, "Author/Book/01.mp3/entry.xml")))
      ) {
        held = true;
        entered.open();
        await release.promise;
      }

      return result;
    }) as typeof filesystem.stat);

    cleanups.push(async () => {
      release.open();
      readSpy.mockRestore();
      statSpy.mockRestore();
    });

    // #when
    const pass = app.runInitialSync();
    await entered.promise;
    const shutdown = app.shutdown(1000);
    release.open();
    const outcome = await shutdown;
    const successful = await pass;
    readSpy.mockRestore();
    statSpy.mockRestore();

    // #then
    expect({
      outcome,
      successful,
      ready: app.isPublicationReady(),
      laterOperations,
      preserved: (await Bun.file(join(dataPath, "feed.opml")).text()) === previous,
    }).toEqual({
      outcome: "completed",
      successful: false,
      ready: false,
      laterOperations: [],
      preserved: true,
    });
  },
);
