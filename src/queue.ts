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
  private pendingKeys = new Map<string, T>();
  private dirtyKeys = new Set<string>();
  private coveredKeys = new Set<string>();
  private followups = new Map<string, T>();
  private active = 0;
  private paused = false;
  private readonly stopping = new AbortController();
  private expired = false;
  private inactiveWaiters: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private waiters: Array<{
    resolve: (item: T) => void;
  }> = [];

  constructor(private readonly getKey?: (item: T) => string | null | undefined) {}

  keyFor(item: T): string | null | undefined {
    return this.getKey?.(item);
  }

  pendingFor(item: T): T | undefined {
    const key = this.keyFor(item);

    return key ? this.pendingKeys.get(key) : undefined;
  }

  enqueue(item: T, covered = false): boolean {
    const waiter = this.paused ? undefined : this.waiters.shift();

    if (waiter) {
      this.active++;
      waiter.resolve(item);

      return true;
    } else {
      const key = this.keyFor(item);

      if (key) {
        if (covered) {
          this.coveredKeys.add(key);
          this.dirtyKeys.delete(key);
        }

        if (this.pendingKeys.has(key)) {
          if (!covered && this.coveredKeys.has(key)) {
            this.followups.set(key, item);
          } else if (!covered) {
            this.dirtyKeys.add(key);
          }

          return false;
        }

        this.pendingKeys.set(key, item);
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
    if (this.stopping.signal.aborted) throw this.stopping.signal.reason;

    if (!this.paused && this.buffer.length > 0) {
      while (this.buffer.length > 0) {
        const item = this.buffer.shift()!;
        const key = this.keyFor(item);

        if (key && this.dirtyKeys.delete(key)) {
          this.buffer.push(item);
          continue;
        }

        if (key) this.releaseKey(key);

        this.active++;

        return item;
      }
    }

    if (signal?.aborted) throw signal.reason;

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(entry);

        if (idx !== -1) this.waiters.splice(idx, 1);
        this.stopping.signal.removeEventListener("abort", onStop);
        reject(signal!.reason);
      };

      const onStop = () => {
        const idx = this.waiters.indexOf(entry);

        if (idx !== -1) this.waiters.splice(idx, 1);
        signal?.removeEventListener("abort", onAbort);
        reject(this.stopping.signal.reason);
      };

      const entry = {
        resolve: (item: T) => {
          signal?.removeEventListener("abort", onAbort);
          this.stopping.signal.removeEventListener("abort", onStop);
          resolve(item);
        },
      };

      this.waiters.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.stopping.signal.addEventListener("abort", onStop, { once: true });
    });
  }

  get size(): number {
    return this.buffer.length;
  }

  private releaseKey(key: string): void {
    this.pendingKeys.delete(key);
    this.coveredKeys.delete(key);
    const followup = this.followups.get(key);
    this.followups.delete(key);

    if (followup !== undefined) this.enqueue(followup);
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
    if (this.isStopped()) return;
    this.paused = false;

    while (this.waiters.length > 0 && this.buffer.length > 0) {
      const item = this.buffer.shift()!;
      const key = this.keyFor(item);

      if (key && this.dirtyKeys.delete(key)) {
        this.buffer.push(item);
        continue;
      }

      const waiter = this.waiters.shift()!;

      if (key) this.releaseKey(key);
      this.active++;
      waiter.resolve(item);
    }
  }

  isStopped(): boolean {
    return this.stopping.signal.aborted;
  }

  stop(): Promise<void> {
    const inactive = this.pause();
    this.stopping.abort(new Error("Application stopping"));

    return inactive;
  }

  expire(): void {
    this.expired = true;
  }

  checkDeadline(): void {
    if (this.expired) throw new Error("Shutdown deadline expired");
  }
}
