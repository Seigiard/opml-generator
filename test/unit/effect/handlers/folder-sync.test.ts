import { describe, test, expect, beforeEach } from "bun:test";
import { folderSync } from "../../../../src/effect/handlers/folder-sync.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";

const mockFs = {
  mkdirCalls: [] as Array<{ path: string; options?: { recursive?: boolean } }>,
  atomicWriteCalls: [] as Array<{ path: string; content: string }>,
  reset() {
    this.mkdirCalls = [];
    this.atomicWriteCalls = [];
  },
};

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string }>,
  reset() {
    this.infoCalls = [];
  },
};

function makeDeps(): HandlerDeps {
  return {
    config: { filesPath: "/audiobooks", dataPath: "/data", port: 3000, reconcileInterval: 1800 },
    logger: {
      info: (tag, msg) => {
        mockLogger.infoCalls.push({ tag, msg });
      },
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    fs: {
      mkdir: async (path, options) => {
        mockFs.mkdirCalls.push({ path, options });
      },
      rm: async () => {},
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => false, size: 0 }),
      exists: async () => false,
      writeFile: async () => {},
      atomicWrite: async (path, content) => {
        mockFs.atomicWriteCalls.push({ path, content });
      },
      symlink: async () => {},
      unlink: async () => {},
    },
  };
}

describe("folderSync handler", () => {
  beforeEach(() => {
    mockFs.reset();
    mockLogger.reset();
  });

  test("returns empty array for non-FolderCreated events", async () => {
    // #given
    const event: EventType = { _tag: "FolderDeleted", parent: "/audiobooks", name: "Book" };
    // #when
    const result = await folderSync(event, makeDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("creates data directory and writes _entry.xml", async () => {
    // #given
    const event: EventType = { _tag: "FolderCreated", parent: "/audiobooks", name: "Author" };
    // #when
    const result = await folderSync(event, makeDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(mockFs.mkdirCalls).toHaveLength(1);
    expect(mockFs.mkdirCalls[0]!.path).toBe("/data/Author");
    expect(mockFs.atomicWriteCalls).toHaveLength(1);
    expect(mockFs.atomicWriteCalls[0]!.path).toContain("_entry.xml");
    expect(mockFs.atomicWriteCalls[0]!.content).toContain("Author");
  });

  test("skips _entry.xml for root folder", async () => {
    // #given — root folder has empty relativePath
    const event: EventType = { _tag: "FolderCreated", parent: "/audiobooks", name: "" };
    const deps = makeDeps();
    // #when
    const result = await folderSync(event, deps);
    // #then
    expect(result.isOk()).toBe(true);
    expect(mockFs.atomicWriteCalls).toHaveLength(0);
    expect(mockLogger.infoCalls.some((c) => c.msg.includes("Root folder"))).toBe(true);
  });

  test("always cascades FolderMetaSyncRequested", async () => {
    // #given
    const event: EventType = { _tag: "FolderCreated", parent: "/audiobooks", name: "Author" };
    // #when
    const result = await folderSync(event, makeDeps());
    // #then
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(1);
    expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Author" });
  });

  test("returns err on filesystem error", async () => {
    // #given
    const deps = makeDeps();
    deps.fs.mkdir = async () => {
      throw new Error("disk full");
    };
    const event: EventType = { _tag: "FolderCreated", parent: "/audiobooks", name: "Author" };
    // #when
    const result = await folderSync(event, deps);
    // #then
    expect(result.isErr()).toBe(true);
  });
});
