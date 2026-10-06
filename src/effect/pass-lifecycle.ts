import type { SimpleQueue } from "../queue.ts";
import type { EventType, PassScopedEvent } from "./types.ts";

interface PassState {
  readonly id: string;
  pending: number;
  readonly directKeys: Set<string>;
  readonly coalescedKeys: Set<string>;
  readonly errors: Error[];
  readonly promise: Promise<void>;
  resolve: () => void;
}

export class PassLifecycle {
  private nextId = 0;
  private readonly passes = new Map<string, PassState>();

  startPass(): string {
    const id = `pass-${++this.nextId}`;
    let resolve!: () => void;

    const promise = new Promise<void>((done) => {
      resolve = done;
    });

    this.passes.set(id, {
      id,
      pending: 0,
      directKeys: new Set(),
      coalescedKeys: new Set(),
      errors: [],
      promise,
      resolve,
    });

    return id;
  }

  enqueueMany(
    queue: SimpleQueue<PassScopedEvent>,
    events: readonly EventType[],
    passId: string,
  ): void {
    for (const event of events) this.enqueue(queue, event, passId);
  }

  enqueue(queue: SimpleQueue<PassScopedEvent>, event: EventType, passId: string): void {
    const state = this.passes.get(passId);

    if (!state) {
      queue.enqueue(event);

      return;
    }

    const scopedEvent = { ...event, __passId: passId };
    const key = queue.keyFor(scopedEvent);
    const accepted = queue.enqueue(scopedEvent);

    if (accepted) {
      state.pending++;

      if (key) state.directKeys.add(key);

      return;
    }

    if (!key || state.directKeys.has(key) || state.coalescedKeys.has(key)) return;

    state.pending++;
    state.coalescedKeys.add(key);
  }

  enqueueCascades(
    queue: SimpleQueue<PassScopedEvent>,
    parent: PassScopedEvent,
    cascades: readonly EventType[],
  ): void {
    const owners = new Set<string>();

    if (parent.__passId) owners.add(parent.__passId);
    const key = queue.keyFor(parent);

    if (key) {
      for (const state of this.passes.values()) {
        if (state.coalescedKeys.has(key)) owners.add(state.id);
      }
    }

    if (owners.size === 0) {
      queue.enqueueMany(cascades);

      return;
    }

    for (const passId of owners) this.enqueueMany(queue, cascades, passId);
  }

  complete(event: PassScopedEvent, error?: Error, key?: string | null): void {
    const passId = event.__passId;

    if (passId) this.completePassEvent(passId, error, key);

    if (!key) return;

    for (const state of this.passes.values()) {
      if (!state.coalescedKeys.delete(key)) continue;
      this.completePassState(state, error);
    }
  }

  private completePassEvent(passId: string, error?: Error, key?: string | null): void {
    const state = this.passes.get(passId);

    if (!state) return;

    if (key) state.directKeys.delete(key);
    this.completePassState(state, error);
  }

  private completePassState(state: PassState, error?: Error): void {
    if (state.pending === 0) return;

    if (error) state.errors.push(error);
    state.pending--;

    if (state.pending === 0) state.resolve();
  }

  async waitFor(passId: string): Promise<void> {
    const state = this.passes.get(passId);

    if (!state) return;

    if (state.pending > 0) await state.promise;

    this.passes.delete(passId);

    if (state.errors.length > 0) {
      throw new AggregateError(state.errors, "Synchronization pass failed");
    }
  }
}
