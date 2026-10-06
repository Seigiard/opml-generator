import type { SimpleQueue } from "../queue.ts";
import type { EventType, PassScopedEvent } from "./types.ts";

interface PassState {
  readonly id: string;
  pending: number;
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
    this.passes.set(id, { id, pending: 0, errors: [], promise, resolve });

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

    state.pending++;
    const accepted = queue.enqueue({ ...event, __passId: passId });

    if (!accepted) this.complete({ ...event, __passId: passId });
  }

  enqueueCascades(
    queue: SimpleQueue<PassScopedEvent>,
    parent: PassScopedEvent,
    cascades: readonly EventType[],
  ): void {
    const passId = parent.__passId;

    if (!passId) {
      queue.enqueueMany(cascades);

      return;
    }

    this.enqueueMany(queue, cascades, passId);
  }

  complete(event: PassScopedEvent, error?: Error): void {
    const passId = event.__passId;

    if (!passId) return;

    const state = this.passes.get(passId);

    if (!state) return;

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
