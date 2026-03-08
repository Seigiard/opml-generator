import { describe, test, expect, beforeEach } from "bun:test";
import { Effect, Layer } from "effect";
import { ConfigService, LoggerService, FileSystemService } from "../../../../src/effect/services.ts";
import { folderEntryXmlChanged } from "../../../../src/effect/handlers/folder-entry-xml-changed.ts";
import type { EventType } from "../../../../src/effect/types.ts";

const mockLogger = {
  infoCalls: [] as Array<{ tag: string; msg: string }>,
  reset() {
    this.infoCalls = [];
  },
};

const TestConfigService = Layer.succeed(ConfigService, {
  filesPath: "/files",
  dataPath: "/data",
  port: 3000,
});

const TestLoggerService = Layer.succeed(LoggerService, {
  info: (tag, msg) =>
    Effect.sync(() => {
      mockLogger.infoCalls.push({ tag, msg });
    }),
  warn: () => Effect.void,
  error: () => Effect.void,
  debug: () => Effect.void,
});

const TestFileSystemService = Layer.succeed(FileSystemService, {
  mkdir: () => Effect.void,
  rm: () => Effect.void,
  readdir: () => Effect.succeed([]),
  stat: () => Effect.succeed({ isDirectory: () => false, size: 0 }),
  exists: () => Effect.succeed(false),
  writeFile: () => Effect.void,
  atomicWrite: () => Effect.void,
  symlink: () => Effect.void,
  unlink: () => Effect.void,
});

const TestLayer = Layer.mergeAll(TestConfigService, TestLoggerService, TestFileSystemService);

const folderEntryXmlChangedEvent = (parent: string): EventType => ({
  _tag: "FolderEntryXmlChanged",
  parent,
});

describe("folderEntryXmlChanged handler", () => {
  beforeEach(() => {
    mockLogger.reset();
  });

  test("returns empty array for non-FolderEntryXmlChanged events", async () => {
    const event: EventType = { _tag: "AudioFileCreated", parent: "/files", name: "chapter01.mp3" };
    const cascades = await Effect.runPromise(Effect.provide(folderEntryXmlChanged(event), TestLayer));

    expect(cascades).toEqual([]);
  });

  test("returns two FolderMetaSyncRequested events (current and parent)", async () => {
    const cascades = await Effect.runPromise(
      Effect.provide(folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction/Author")), TestLayer),
    );

    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction/Author",
    });
    expect(cascades[1]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction",
    });
  });

  test("returns root as parent when folder is top-level", async () => {
    const cascades = await Effect.runPromise(Effect.provide(folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction")), TestLayer));

    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction",
    });
    expect(cascades[1]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data",
    });
  });

  test("handles deeply nested folders", async () => {
    const cascades = await Effect.runPromise(
      Effect.provide(folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction/SciFi/Author")), TestLayer),
    );

    expect(cascades).toHaveLength(2);
    expect(cascades[0]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction/SciFi/Author",
    });
    expect(cascades[1]).toEqual({
      _tag: "FolderMetaSyncRequested",
      path: "/data/Fiction/SciFi",
    });
  });

  test("handles trailing slash in path", async () => {
    const cascades = await Effect.runPromise(
      Effect.provide(folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction/Author/")), TestLayer),
    );

    expect(cascades).toHaveLength(2);
    expect((cascades[0] as { _tag: "FolderMetaSyncRequested"; path: string }).path).toBe("/data/Fiction/Author");
  });

  test("logs the action", async () => {
    await Effect.runPromise(Effect.provide(folderEntryXmlChanged(folderEntryXmlChangedEvent("/data/Fiction")), TestLayer));

    expect(mockLogger.infoCalls.some((c) => c.tag === "FolderEntryXmlChanged")).toBe(true);
  });
});
