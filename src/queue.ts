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
  private pendingKeys = new Set<string>();
  private dirtyKeys = new Set<string>();
  private active = 0;
  private paused = false;
  private inactiveWaiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private waiters: Array<{
    resolve: (item: T) => void;
  }> = [];

  constructor(private readonly getKey?: (item: T) => string | null | undefined) {}

  keyFor(item: T): string | null | undefined {
    return this.getKey?.(item);
  }

  enqueue(item: T): boolean {
    const waiter = this.paused ? undefined : this.waiters.shift();

    if (waiter) {
      this.active++;
      waiter.resolve(item);

      return true;
    } else {
      const key = this.keyFor(item);

      if (key) {
        if (this.pendingKeys.has(key)) {
          this.dirtyKeys.add(key);

          return false;
        }

        this.pendingKeys.add(key);
      }

      this.buffer.push(item);

      return true;
    }
  }

  enqueueMany(items: readonly T[]): number {
    let accepted = 0;

    for (const item of items) {
      if (this.enqueue(item)) accepted++;
    }

    return accepted;
  }

  async take(signal?: AbortSignal): Promise<T> {
    if (!this.paused && this.buffer.length > 0) {
      while (this.buffer.length > 0) {
        const item = this.buffer.shift()!;
        const key = this.keyFor(item);

        if (key && this.dirtyKeys.delete(key)) {
          this.buffer.push(item);
          continue;
        }

        if (key) this.pendingKeys.delete(key);

        this.active++;

        return item;
      }
    }

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
      };

      this.waiters.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  get size(): number {
    return this.buffer.length;
  }

  complete(): void {
    this.active--;

    if (this.active === 0) {
      for (const resolve of this.inactiveWaiters.splice(0)) resolve();
    }

    if (this.active !== 0 || this.buffer.length !== 0) return;

    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  async whenIdle(): Promise<void> {
    if (this.active === 0 && this.buffer.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async pause(): Promise<void> {
    this.paused = true;

    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.inactiveWaiters.push(resolve));
  }

  resume(): void {
    this.paused = false;

    while (this.waiters.length > 0 && this.buffer.length > 0) {
      const item = this.buffer.shift()!;
      const key = this.keyFor(item);

      if (key && this.dirtyKeys.delete(key)) {
        this.buffer.push(item);
        continue;
      }

      if (key) this.pendingKeys.delete(key);
      this.active++;
      this.waiters.shift()!.resolve(item);
    }
  }
}
