import { describe, test, expect } from "bun:test";
import { SimpleQueue, QueueChunk, UnrolledQueue, CHUNK_SIZE } from "../../src/queue.ts";

describe("QueueChunk", () => {
  test("push and shift items", () => {
    // #given
    const chunk = new QueueChunk<number>();
    // #when
    chunk.push(1);
    chunk.push(2);
    // #then
    expect(chunk.shift()).toBe(1);
    expect(chunk.shift()).toBe(2);
    expect(chunk.length).toBe(0);
  });

  test("returns false when full", () => {
    // #given
    const chunk = new QueueChunk<number>();
    for (let i = 0; i < CHUNK_SIZE; i++) chunk.push(i);
    // #then
    expect(chunk.push(999)).toBe(false);
  });

  test("reset clears all state", () => {
    // #given
    const chunk = new QueueChunk<number>();
    chunk.push(1);
    chunk.push(2);
    chunk.shift();
    // #when
    chunk.reset();
    // #then
    expect(chunk.length).toBe(0);
    expect(chunk.readIndex).toBe(0);
    expect(chunk.writeIndex).toBe(0);
  });
});

describe("UnrolledQueue", () => {
  test("push and shift items in FIFO order", () => {
    // #given
    const q = new UnrolledQueue<string>();
    q.push("a");
    q.push("b");
    q.push("c");
    // #then
    expect(q.shift()).toBe("a");
    expect(q.shift()).toBe("b");
    expect(q.shift()).toBe("c");
    expect(q.length).toBe(0);
  });

  test("handles more items than one chunk", () => {
    // #given
    const q = new UnrolledQueue<number>();
    const count = CHUNK_SIZE + 100;
    for (let i = 0; i < count; i++) q.push(i);
    // #then
    expect(q.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(q.shift()).toBe(i);
    }
    expect(q.length).toBe(0);
  });
});

describe("SimpleQueue", () => {
  test("enqueue and take (sync path)", async () => {
    // #given
    const q = new SimpleQueue<string>();
    q.enqueue("a");
    q.enqueue("b");
    // #when / #then
    expect(await q.take()).toBe("a");
    expect(await q.take()).toBe("b");
  });

  test("take waits for enqueue (async path)", async () => {
    // #given
    const q = new SimpleQueue<string>();
    const promise = q.take();
    // #when
    q.enqueue("delayed");
    // #then
    expect(await promise).toBe("delayed");
  });

  test("take respects AbortSignal", async () => {
    // #given
    const q = new SimpleQueue<string>();
    const controller = new AbortController();
    const promise = q.take(controller.signal);
    // #when
    controller.abort();
    // #then
    await expect(promise).rejects.toThrow();
  });

  test("take rejects immediately if signal already aborted", async () => {
    // #given
    const q = new SimpleQueue<string>();
    const controller = new AbortController();
    controller.abort();
    // #then
    await expect(q.take(controller.signal)).rejects.toThrow();
  });

  test("enqueueMany adds multiple items", async () => {
    // #given
    const q = new SimpleQueue<number>();
    q.enqueueMany([1, 2, 3]);
    // #then
    expect(q.size).toBe(3);
    expect(await q.take()).toBe(1);
    expect(await q.take()).toBe(2);
    expect(await q.take()).toBe(3);
  });

  test("size reflects current buffer length", () => {
    // #given
    const q = new SimpleQueue<number>();
    expect(q.size).toBe(0);
    // #when
    q.enqueue(1);
    q.enqueue(2);
    // #then
    expect(q.size).toBe(2);
  });
});
