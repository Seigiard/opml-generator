import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { HandlerDeps } from "../../../src/context.ts";
import type { EpisodeEngineRuntime } from "../../../src/engine/runtime.ts";
import { startEpisodeEngineRuntime } from "../../../src/engine/runtime.ts";
import { createServerFetch } from "../../../src/server.ts";
import { cleanupTempDir, createTempDir } from "../../helpers/fs-helpers.ts";

const AUDIO_FIXTURES = join(import.meta.dir, "../../fixtures/audio");

let root = "";

let filesPath = "";

let dataPath = "";

function realDeps(): HandlerDeps {
  return {
    config: {
      filesPath,
      dataPath,
      port: 3000,
      reconcileInterval: 0,
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    fs: {
      mkdir: async (path, options) => {
        await mkdir(path, options);
      },
      rm: (path, options) => rm(path, options),
      readdir: (path) => readdir(path),
      lstat: (path) => stat(path),
      stat: async (path) => {
        const s = await stat(path);

        return { isDirectory: () => s.isDirectory(), size: s.size };
      },
      exists: async (path) => {
        try {
          await stat(path);

          return true;
        } catch {
          return false;
        }
      },
      writeFile: async (path, content) => {
        await Bun.write(path, content);
      },
      atomicWrite: async (path, content) => {
        const tmpPath = `${path}.tmp`;
        await Bun.write(tmpPath, content);
        await rename(tmpPath, path);
      },
      symlink: (target, path) => symlink(target, path),
      unlink: (path) => unlink(path),
    },
  };
}

async function waitFor(check: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return true;
    await Bun.sleep(20);
  }

  return false;
}

describe("episode engine runtime", () => {
  beforeEach(async () => {
    root = await createTempDir("opml-engine-runtime");
    filesPath = join(root, "audiobooks");
    dataPath = join(root, "data");
    await mkdir(filesPath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  test("notifyBooksEvent translates watcher parent and name to a source-relative changed path", async () => {
    // #given
    const runtime = startEpisodeEngineRuntime(realDeps());
    await runtime.ready;
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await Bun.write(
      join(filesPath, "Author", "Album", "01.mp3"),
      Bun.file(join(AUDIO_FIXTURES, "tagged.mp3")),
    );

    // #when
    const admission = await runtime.notifyBooksEvent({
      parent: join(filesPath, "Author", "Album"),
      name: "01.mp3",
      events: "CLOSE_WRITE",
    });
    const published = await waitFor(() =>
      Bun.file(join(dataPath, "Author", "Album", "01.mp3", "entry.xml")).exists(),
    );
    await runtime.stop();

    // #then
    expect({ admission, published }).toEqual({ admission: "started", published: true });
  });

  test("stop before ready settles cleanly instead of rejecting ready", async () => {
    // #given
    await mkdir(join(filesPath, "Author", "Album"), { recursive: true });
    await Bun.write(
      join(filesPath, "Author", "Album", "01.mp3"),
      Bun.file(join(AUDIO_FIXTURES, "tagged.mp3")),
    );
    const deps = realDeps();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    deps.fs.atomicWrite = async (path, content) => {
      entered.resolve();
      await release.promise;
      const tmpPath = `${path}.tmp`;
      await Bun.write(tmpPath, content);
      await rename(tmpPath, path);
    };
    const runtime = startEpisodeEngineRuntime(deps);
    await entered.promise;

    // #when
    const stopped = runtime.stop().then(
      () => true,
      () => false,
    );
    const readySettled = runtime.ready.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );
    release.resolve();

    // #then
    expect({ stopped: await stopped, ready: await readySettled }).toEqual({
      stopped: true,
      ready: "fulfilled",
    });
  });
});

describe("server HTTP event handler", () => {
  test("malformed books JSON returns 400 instead of throwing", async () => {
    // #given
    const fetch = createServerFetch(fakeRuntime());

    // #when
    const response = await fetch(
      new Request("http://127.0.0.1/events/books", { method: "POST", body: "{" }),
    );

    // #then
    expect({ status: response.status, text: await response.text() }).toEqual({
      status: 400,
      text: "Invalid event",
    });
  });

  test("valid books JSON maps to notifyBooksEvent", async () => {
    // #given
    const calls: unknown[] = [];
    const fetch = createServerFetch(
      fakeRuntime({
        notifyBooksEvent: async (event) => {
          calls.push(event);

          return "queued";
        },
      }),
    );

    // #when
    const response = await fetch(
      new Request("http://127.0.0.1/events/books", {
        method: "POST",
        body: JSON.stringify({ parent: "/audiobooks/Author", name: "01.mp3", events: "CREATE" }),
      }),
    );

    // #then
    expect({ status: response.status, text: await response.text(), calls }).toEqual({
      status: 202,
      text: "OK",
      calls: [{ parent: "/audiobooks/Author", name: "01.mp3", events: "CREATE" }],
    });
  });
});

function fakeRuntime(overrides: Partial<EpisodeEngineRuntime> = {}): EpisodeEngineRuntime {
  return {
    ready: Promise.resolve(),
    status: async () => ({
      state: "complete",
      pass: null,
      followUp: null,
      failure: null,
      work: { state: "complete", pending: 0, active: null, errors: [] },
      available: true,
      availableFrom: "minimum-publication",
      verifying: false,
      completed: true,
      errors: [],
    }),
    notifyBooksEvent: async () => "queued",
    requestPass: async () => "queued",
    stop: async () => undefined,
    ...overrides,
  };
}
