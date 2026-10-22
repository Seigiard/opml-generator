import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cacheMirrors } from "../../src/cache-mirrors.ts";

describe("cacheMirrors", () => {
  test("skips entries that vanish during traversal", async () => {
    // #given
    const root = "/cache";
    const stable = join(root, "Author");
    const vanishedRootEntry = join(root, "Gone");
    const vanishedContainerEntry = join(root, "~", "Vanished");
    const absentRootEntry = Object.assign(new Error("missing"), { code: "ENOENT" });
    const absentContainerEntry = Object.assign(new Error("not a directory"), { code: "ENOTDIR" });

    // #when
    const mirrors = cacheMirrors(root, root, {
      readdir: async (path) => {
        if (path === root) return ["Author", "Gone", "~"];

        if (path === join(root, "~")) return [".sync-engine", "Vanished"];

        if (path === join(root, "~", ".sync-engine")) return ["freshness.json.tmp"];

        return [];
      },
      stat: async (path) => {
        if (path === stable || path === join(root, "~") || path === join(root, "~", ".sync-engine"))
          return { isDirectory: () => true, size: 0 };

        if (path === vanishedRootEntry) throw absentRootEntry;

        if (path === vanishedContainerEntry) throw absentContainerEntry;

        return { isDirectory: () => false, size: 0 };
      },
    });

    // #then
    await expect(mirrors).resolves.toEqual([{ name: "Author", path: stable }]);
  });
});
