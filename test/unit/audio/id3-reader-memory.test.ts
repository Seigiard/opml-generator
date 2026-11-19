import { expect, test } from "bun:test";
import { copyFile, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = join(import.meta.dir, "../../fixtures/audio/tagged.m4a");

const reader = join(import.meta.dir, "../../../src/audio/id3-reader.ts");

const freeAtomSize = 512 * 1024 * 1024;

const memoryLimitKb = 256 * 1024;

async function measureReader(operation: "metadata" | "cover") {
  const directory = await mkdtemp(join(tmpdir(), "id3-memory-"));
  const audio = join(directory, "large.m4a");

  try {
    await copyFile(fixture, audio);
    const file = await open(audio, "r+");

    try {
      const { size } = await file.stat();
      const header = Buffer.alloc(8);
      header.writeUInt32BE(freeAtomSize, 0);
      header.write("free", 4);
      await file.write(header, 0, header.length, size);
      await file.truncate(size + freeAtomSize);
    } finally {
      await file.close();
    }

    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `
          const reader = await import(process.argv[1]);
          const value = process.argv[3] === "metadata"
            ? (await reader.readAudioMetadata(process.argv[2])).title
            : await reader.extractEmbeddedCover(process.argv[2]);
          const status = await Bun.file("/proc/self/status").text();
          const peakKb = Number(status.match(/^VmHWM:\\s+(\\d+) kB$/m)?.[1]);
          console.log(JSON.stringify({ value, peakKb }));
        `,
        reader,
        audio,
        operation,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const [output, error, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" });

    const result: { value: unknown; peakKb: number } = JSON.parse(output);

    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reads metadata from a large audiobook without loading the file into memory", async () => {
  // #given
  const operation = "metadata";

  // #when
  const result = await measureReader(operation);

  // #then
  expect(result.value).toBe("M4A Title");
  expect(result.peakKb).toBeLessThan(memoryLimitKb);
}, 60000);

test("checks for an embedded cover in a large audiobook without loading the file into memory", async () => {
  // #given
  const operation = "cover";

  // #when
  const result = await measureReader(operation);

  // #then
  expect(result.value).toBeNull();
  expect(result.peakKb).toBeLessThan(memoryLimitKb);
}, 60000);
