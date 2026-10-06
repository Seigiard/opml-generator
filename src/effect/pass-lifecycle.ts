import type { SimpleQueue } from "../queue.ts";
import type { EventType, PassScopedEvent } from "./types.ts";

interface PassState {
  pending: number;
  readonly errors: Error[];
  readonly promise: Promise<void>;
  resolve: () => void;
}

export class PassLifecycle {
  private nextId = 0;
  private readonly passes = new Map<string, PassState>();
  private readonly owners = new WeakMap<PassScopedEvent, Set<string>>();

  startPass(): string {
    const id = `pass-${++this.nextId}`;
    let resolve!: () => void;

    const promise = new Promise<void>((done) => {
      resolve = done;
    });

    this.passes.set(id, {
      pending: 0,
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
    const accepted = queue.enqueue(scopedEvent, true);
    const occurrence = accepted ? scopedEvent : queue.pendingFor(scopedEvent);

    if (!occurrence) return;
    const owners = this.owners.get(occurrence) ?? new Set<string>();

    if (owners.has(passId)) return;

    owners.add(passId);
    this.owners.set(occurrence, owners);
    state.pending++;
  }

  enqueueCascades(
    queue: SimpleQueue<PassScopedEvent>,
    parent: PassScopedEvent,
    cascades: readonly EventType[],
  ): void {
    const owners = this.owners.get(parent);

    if (!owners || owners.size === 0) {
      queue.enqueueMany(cascades);

      return;
    }

    for (const passId of owners) this.enqueueMany(queue, cascades, passId);
  }

  complete(event: PassScopedEvent, error?: Error): void {
    const owners = this.owners.get(event);
    this.owners.delete(event);

    if (!owners) return;

    for (const passId of owners) {
      const state = this.passes.get(passId);

      if (state) this.completePassState(state, error);
    }
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
