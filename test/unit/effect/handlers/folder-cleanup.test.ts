import { describe, test, expect, beforeEach } from "bun:test";
import { folderCleanup } from "../../../../src/effect/handlers/folder-cleanup.ts";
import type { HandlerDeps } from "../../../../src/context.ts";
import type { EventType } from "../../../../src/effect/types.ts";

const mockFs = {
  rmCalls: [] as Array<{ path: string }>,
  rmError: null as Error | null,
  reset() {
    this.rmCalls = [];
    this.rmError = null;
  },
};

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string }>,
  debugCalls: [] as Array<{ tag: string; msg: string }>,
  reset() {
    this.infoCalls = [];
    this.debugCalls = [];
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
      debug: (tag, msg) => {
        mockLogger.debugCalls.push({ tag, msg });
      },
    },
    fs: {
      mkdir: async () => {},
      rm: async (path) => {
        mockFs.rmCalls.push({ path });
        if (mockFs.rmError) throw mockFs.rmError;
      },
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => false, size: 0 }),
      exists: async () => false,
      writeFile: async () => {},
      atomicWrite: async () => {},
      symlink: async () => {},
      unlink: async () => {},
    },
  };
}

describe("folderCleanup handler", () => {
  beforeEach(() => {
    mockFs.reset();
    mockLogger.reset();
  });

  test("returns empty array for non-FolderDeleted events", async () => {
    // #given
    const event: EventType = { _tag: "FolderCreated", parent: "/audiobooks", name: "Book" };
    // #when
    const result = await folderCleanup(event, makeDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("removes folder and cascades to parent", async () => {
    // #given
    const event: EventType = { _tag: "FolderDeleted", parent: "/audiobooks/Author", name: "Book" };
    // #when
    const result = await folderCleanup(event, makeDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(mockFs.rmCalls[0]!.path).toBe("/data/Author/Book");
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(1);
    expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Author" });
  });

  test("no cascade when at root level", async () => {
    // #given
    const event: EventType = { _tag: "FolderDeleted", parent: "/audiobooks", name: "Book" };
    // #when
    const result = await folderCleanup(event, makeDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("suppresses ENOENT error", async () => {
    // #given
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockFs.rmError = enoent;
    const event: EventType = { _tag: "FolderDeleted", parent: "/audiobooks/Author", name: "Book" };
    // #when
    const result = await folderCleanup(event, makeDeps());
    // #then
    expect(result.isOk()).toBe(true);
    expect(mockLogger.debugCalls.some((c) => c.tag === "FolderCleanup")).toBe(true);
  });

  test("returns err on non-ENOENT error", async () => {
    // #given
    const permError = Object.assign(new Error("EPERM"), { code: "EPERM" });
    mockFs.rmError = permError;
    const event: EventType = { _tag: "FolderDeleted", parent: "/audiobooks", name: "Book" };
    // #when
    const result = await folderCleanup(event, makeDeps());
    // #then
    expect(result.isErr()).toBe(true);
  });
});
