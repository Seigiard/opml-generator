import { spyOn, type Mock } from "bun:test";

type SpawnResult = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  exitCode: number | null;
  kill: () => void;
  pid: number;
};

interface MockConfig {
  pdfinfo?: string;
  pdftoppm?: Buffer;
  magick?: boolean;
}

let spawnSpy: Mock<typeof Bun.spawn> | null = null;

let mockConfig: MockConfig = {};

function createReadableStream(data: string | Buffer): ReadableStream<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createEmptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function createMockSpawnResult(stdout: string | Buffer, exitCode = 0): SpawnResult {
  return {
    stdout: createReadableStream(stdout),
    stderr: createEmptyStream(),
    exited: Promise.resolve(exitCode),
    exitCode,
    kill: () => {},
    pid: 12345,
  };
}

export function mockPdfInfo(output: string): void {
  mockConfig.pdfinfo = output;
  setupSpawnSpy();
}

export function mockPdfToPpm(imageBuffer: Buffer): void {
  mockConfig.pdftoppm = imageBuffer;
  setupSpawnSpy();
}

export function mockImageMagick(success: boolean): void {
  mockConfig.magick = success;
  setupSpawnSpy();
}

function setupSpawnSpy(): void {
  if (spawnSpy) return;

  const originalSpawn = Bun.spawn.bind(Bun);

  spawnSpy = spyOn(Bun, "spawn").mockImplementation((cmd: any, options?: any) => {
    const cmdArray = Array.isArray(cmd) ? cmd : [cmd];
    const command = cmdArray[0];

    if (command === "pdfinfo" && mockConfig.pdfinfo !== undefined) {
      return createMockSpawnResult(mockConfig.pdfinfo) as any;
    }

    if (command === "pdftoppm" && mockConfig.pdftoppm !== undefined) {
      return createMockSpawnResult(mockConfig.pdftoppm) as any;
    }

    if (command === "magick" && mockConfig.magick !== undefined) {
      return createMockSpawnResult("", mockConfig.magick ? 0 : 1) as any;
    }

    return originalSpawn(cmdArray, options);
  });
}

export function resetMocks(): void {
  if (spawnSpy) {
    spawnSpy.mockRestore();
    spawnSpy = null;
  }

  mockConfig = {};
}

export function getMockCalls(): string[][] {
  if (!spawnSpy) return [];

  return spawnSpy.mock.calls.map((call) => {
    const cmd = call[0];

    return Array.isArray(cmd) ? cmd : [cmd];
  });
}
