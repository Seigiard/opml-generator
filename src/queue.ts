export const CHUNK_SIZE = 2048;

export class QueueChunk<T> {
  readonly buffer: (T | undefined)[];
  readIndex = 0;
  writeIndex = 0;
  next: QueueChunk<T> | null = null;

  constructor() {
    this.buffer = Array.from({ length: CHUNK_SIZE });
  }

  get length(): number {
    return this.writeIndex - this.readIndex;
  }

  push(item: T): boolean {
    if (this.writeIndex >= CHUNK_SIZE) return false;
    this.buffer[this.writeIndex++] = item;
    return true;
  }

  shift(): T | undefined {
    if (this.length === 0) return undefined;
    const index = this.readIndex++;
    const item = this.buffer[index];
    this.buffer[index] = undefined;
    return item;
  }

  reset(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.next = null;
    this.buffer.fill(undefined);
  }
}

export class UnrolledQueue<T> {
  private _length = 0;
  private head: QueueChunk<T>;
  private tail: QueueChunk<T>;
  private spare: QueueChunk<T> | null = null;

  constructor() {
    const chunk = new QueueChunk<T>();
    this.head = chunk;
    this.tail = chunk;
  }

  get length(): number {
    return this._length;
  }

  push(item: T): void {
    if (!this.tail.push(item)) {
      let chunk = this.spare;
      if (chunk) {
        this.spare = null;
      } else {
        chunk = new QueueChunk<T>();
      }
      this.tail.next = chunk;
      this.tail = chunk;
      this.tail.push(item);
    }
    this._length++;
  }

  shift(): T | undefined {
    if (this._length === 0) return undefined;
    const head = this.head;
    const item = head.shift();
    this._length--;
    if (head.length === 0) {
      const next = head.next;
      if (next) {
        this.head = next;
        if (!this.spare) {
          head.reset();
          this.spare = head;
        } else {
          head.next = null;
        }
      } else {
        head.reset();
      }
    }
    return item;
  }
}

export class SimpleQueue<T> {
  private buffer = new UnrolledQueue<T>();
  private waiters: Array<{
    resolve: (item: T) => void;
    reject: (reason: unknown) => void;
  }> = [];

  enqueue(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(item);
    } else {
      this.buffer.push(item);
    }
  }

  enqueueMany(items: readonly T[]): void {
    for (const item of items) this.enqueue(item);
  }

  async take(signal?: AbortSignal): Promise<T> {
    if (this.buffer.length > 0) return this.buffer.shift()!;
    if (signal?.aborted) throw signal.reason;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(entry);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(signal!.reason);
      };
      const entry = {
        resolve: (item: T) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(item);
        },
        reject,
      };
      this.waiters.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  get size(): number {
    return this.buffer.length;
  }
}
