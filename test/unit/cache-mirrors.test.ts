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
    const absent = Object.assign(new Error("missing"), { code: "ENOENT" });

    // #when
    const mirrors = await cacheMirrors(root, root, {
      readdir: async (path) => {
        if (path === root) return ["Author", "Gone", "~"];
        if (path === join(root, "~")) return [".sync-engine", "Vanished"];
        if (path === join(root, "~", ".sync-engine")) return ["freshness.json.tmp"];

        return [];
      },
      stat: async (path) => {
        if (path === stable || path === join(root, "~") || path === join(root, "~", ".sync-engine"))
          return { isDirectory: () => true, size: 0 };

        if (path === vanishedRootEntry || path === vanishedContainerEntry) throw absent;

        return { isDirectory: () => false, size: 0 };
      },
    });

    // #then
    expect(mirrors).toEqual([{ name: "Author", path: stable }]);
  });
});
