import { describe, test, expect, beforeEach } from "bun:test";
import { folderEntryXmlChanged } from "../../../../src/effect/handlers/folder-entry-xml-changed.ts";
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

describe("folderEntryXmlChanged handler", () => {
  beforeEach(() => {
    mockLogger.reset();
  });

  test("returns empty array for non-FolderEntryXmlChanged events", async () => {
    // #given
    const event: EventType = { _tag: "AudioFileCreated", parent: "/files", name: "chapter01.mp3" };
    // #when
    const result = await folderEntryXmlChanged(event, deps);
    // #then
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  test("returns two FolderMetaSyncRequested events (current and parent)", async () => {
    // #given
    const event: EventType = { _tag: "FolderEntryXmlChanged", parent: "/data/Fiction/Author" };
    // #when
    const result = await folderEntryXmlChanged(event, deps);
    // #then
    expect(result.isOk()).toBe(true);
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction/Author" });
    expect(cascades[1]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction" });
  });

  test("returns root as parent when folder is top-level", async () => {
    // #given
    const event: EventType = { _tag: "FolderEntryXmlChanged", parent: "/data/Fiction" };
    // #when
    const result = await folderEntryXmlChanged(event, deps);
    // #then
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction" });
    expect(cascades[1]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data" });
  });

  test("handles deeply nested folders", async () => {
    // #given
    const event: EventType = { _tag: "FolderEntryXmlChanged", parent: "/data/Fiction/SciFi/Author" };
    // #when
    const result = await folderEntryXmlChanged(event, deps);
    // #then
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction/SciFi/Author" });
    expect(cascades[1]).toEqual({ _tag: "FolderMetaSyncRequested", path: "/data/Fiction/SciFi" });
  });

  test("handles trailing slash in path", async () => {
    // #given
    const event: EventType = { _tag: "FolderEntryXmlChanged", parent: "/data/Fiction/Author/" };
    // #when
    const result = await folderEntryXmlChanged(event, deps);
    // #then
    const cascades = result._unsafeUnwrap();
    expect(cascades).toHaveLength(2);
    expect((cascades[0] as { path: string }).path).toBe("/data/Fiction/Author");
  });

  test("logs the action", async () => {
    // #given
    const event: EventType = { _tag: "FolderEntryXmlChanged", parent: "/data/Fiction" };
    // #when
    await folderEntryXmlChanged(event, deps);
    // #then
    expect(mockLogger.infoCalls.some((c) => c.tag === "FolderEntryXmlChanged")).toBe(true);
  });
});
