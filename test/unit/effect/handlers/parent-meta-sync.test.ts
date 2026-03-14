import { describe, test, expect, beforeEach } from "bun:test";
import { parentMetaSync } from "../../../../src/effect/handlers/parent-meta-sync.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string }>,
  reset() {
    this.infoCalls = [];
  },
};

const deps: HandlerDeps = {
  config: { filesPath: "/files", dataPath: "/data", port: 3000, reconcileInterval: 1800 },
  logger: {
    info: (tag, msg) => {
      mockLogger.infoCalls.push({ tag, msg });
    },
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
  fs: {
    mkdir: async () => {},
    rm: async () => {},
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => false, size: 0 }),
    exists: async () => false,
    writeFile: async () => {},
    atomicWrite: async () => {},
    symlink: async () => {},
    unlink: async () => {},
  },
};

describe("parentMetaSync handler", () => {
  beforeEach(() => {
    mockLogger.reset();
  });

  test("returns empty array for non-EntryXmlChanged events", async () => {
    // #given
    const event: EventType = { _tag: "AudioFileCreated", parent: "/files", name: "chapter01.mp3" };
    // #when
    const result = await parentMetaSync(event, deps);
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("returns FolderMetaSyncRequested for parent directory", async () => {
    // #given
    const event: EventType = { _tag: "EntryXmlChanged", parent: "/data/Fiction/Author" };
    // #when
    const result = await parentMetaSync(event, deps);
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    expect(result._unsafeUnwrap()[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction",
    });
  });

  test("returns FolderMetaSyncRequested for root when parent is root", async () => {
    // #given
    const event: EventType = { _tag: "EntryXmlChanged", parent: "/data/Fiction" };
    // #when
    const result = await parentMetaSync(event, deps);
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    expect(result._unsafeUnwrap()[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data",
    });
  });

  test("handles trailing slash in path", async () => {
    // #given
    const event: EventType = { _tag: "EntryXmlChanged", parent: "/data/Fiction/Author/" };
    // #when
    const result = await parentMetaSync(event, deps);
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
    expect(result._unsafeUnwrap()[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction",
    });
  });

  test("logs the action", async () => {
    // #given
    const event: EventType = { _tag: "EntryXmlChanged", parent: "/data/Fiction/Author" };
    // #when
    await parentMetaSync(event, deps);
    // #then
    expect(mockLogger.infoCalls.some((c) => c.tag === "ParentMetaSync")).toBe(true);
  });
});
