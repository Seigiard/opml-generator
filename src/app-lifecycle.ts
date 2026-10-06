import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AppContext } from "./context.ts";
import { OPML_FILE } from "./constants.ts";
import { adaptSyncPlan } from "./effect/adapters/sync-plan-adapter.ts";
import { opmlSync, withPublicationLock } from "./effect/handlers/opml-sync.ts";
import { createSyncPlan, scanFiles } from "./scanner.ts";
import { adaptBooksEvent } from "./effect/adapters/books-adapter.ts";
import type { RawBooksEvent } from "./effect/types.ts";
import { guardFileSystem } from "./stopping.ts";
import { startConsumer } from "./effect/consumer.ts";

async function waitForInterval(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

export class ApplicationLifecycle {
  private admissionReady = false;
  private publicationReady = false;
  private syncing = false;
  private activePass: Promise<boolean> | undefined;
  private readonly stopping = new AbortController();
  private shutdownTask: Promise<"completed" | "deadline"> | undefined;
  private consumerTask: Promise<void> | undefined;
  private reconciliationTask: Promise<void> | undefined;

  constructor(private readonly ctx: AppContext) {}

  startProcessing(): void {
    this.checkRunning();
    this.consumerTask ??= startConsumer(this.ctx, this.stopping.signal);
    this.markAdmissionReady();
  }

  markAdmissionReady(): void {
    if (this.stopping.signal.aborted) return;
    this.admissionReady = true;
  }

  isAdmissionReady(): boolean {
    return this.admissionReady;
  }

  admitBooksEvent(raw: RawBooksEvent): boolean {
    if (!this.admissionReady) return false;
    const event = adaptBooksEvent(raw, { shouldProcess: () => true });

    if (event && "parent" in event && "name" in event) {
      this.ctx.queue.enqueue({
        _tag: "SourcePathSyncRequested",
        path: join(event.parent, event.name),
        isDirectory: event._tag === "FolderCreated" || event._tag === "FolderDeleted",
      });
    }

    return true;
  }

  async waitForIdle(): Promise<void> {
    await this.ctx.queue.whenIdle();
  }

  isPublicationReady(): boolean {
    return this.publicationReady;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  startReconciliation(
    signal: AbortSignal,
    wait: (ms: number, signal: AbortSignal) => Promise<void> = waitForInterval,
  ): Promise<void> {
    this.reconciliationTask ??= this.reconcile(signal, wait);

    return this.reconciliationTask;
  }

  private async reconcile(
    signal: AbortSignal,
    wait: (ms: number, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.ctx.config.reconcileInterval <= 0) return;

    const intervalMs = this.ctx.config.reconcileInterval * 1000;
    let passTask: Promise<boolean> | undefined;

    try {
      while (!signal.aborted && !this.stopping.signal.aborted) {
        await wait(intervalMs, AbortSignal.any([signal, this.stopping.signal]));

        if (signal.aborted || this.stopping.signal.aborted) break;

        if (this.syncing) continue;

        passTask = this.runPublicationPass("Reconciliation");
      }
    } finally {
      await passTask;
    }
  }

  runInitialSync(): Promise<boolean> {
    return this.runPublicationPass("InitialSync");
  }

  runResync(): Promise<boolean> {
    return this.startPass("Resync", true);
  }

  getActivePass(): Promise<boolean> | undefined {
    return this.activePass;
  }

  runPublicationPass(logTag: string): Promise<boolean> {
    return this.startPass(logTag, false);
  }

  private startPass(logTag: string, reset: boolean): Promise<boolean> {
    if (this.syncing || this.stopping.signal.aborted) return Promise.resolve(false);
    this.syncing = true;

    const task = this.executePass(logTag, reset).finally(() => {
      this.syncing = false;
      this.activePass = undefined;
    });

    this.activePass = task;

    return task;
  }

  private async executePass(logTag: string, reset: boolean): Promise<boolean> {
    try {
      if (reset) await this.resetCache();
      this.checkRunning();
      await this.publishCurrentCatalog(logTag);
      this.checkRunning();
      this.publicationReady = true;

      return true;
    } catch (error) {
      this.ctx.logger.error(logTag, "Failed", error);

      return false;
    }
  }

  private async resetCache(): Promise<void> {
    await this.ctx.queue.pause();

    try {
      this.checkRunning();
      this.publicationReady = false;
      await withPublicationLock(this.ctx.fs, async () => {
        this.checkRunning();
        await this.ctx.fs.mkdir(this.ctx.config.dataPath, { recursive: true });
        this.checkRunning();
        const entries = await this.ctx.fs.readdir(this.ctx.config.dataPath);

        for (const entry of entries) {
          this.checkRunning();
          await this.ctx.fs.rm(join(this.ctx.config.dataPath, entry), { recursive: true });
        }
      });
    } finally {
      this.ctx.queue.resume();
    }
  }

  private async publishCurrentCatalog(logTag: string): Promise<void> {
    this.checkRunning();
    this.ctx.logger.info(logTag, "Starting");
    const startTime = Date.now();

    await this.ctx.fs.mkdir(this.ctx.config.dataPath, { recursive: true });
    this.checkRunning();

    const files = await scanFiles(this.ctx.config.filesPath);
    this.checkRunning();
    this.ctx.logger.info(logTag, "Audio files found", { audio_files_found: files.length });

    const plan = await createSyncPlan(files, this.ctx.config.dataPath);
    this.checkRunning();
    this.ctx.logger.info(logTag, "Sync plan created", {
      audio_files_process: plan.toProcess.length,
      audio_files_delete: plan.toDelete.length,
      folders_count: plan.folders.length,
    });

    const events = adaptSyncPlan(plan, this.ctx.config.filesPath);
    const passId = this.ctx.lifecycle.startPass();
    this.ctx.lifecycle.enqueueMany(this.ctx.queue, events, passId);
    let cancel!: () => void;

    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(this.stopping.signal.reason);
    });

    const onStop = () => cancel();
    this.stopping.signal.addEventListener("abort", onStop, { once: true });

    try {
      await Promise.race([this.ctx.lifecycle.waitFor(passId), cancelled]);
    } finally {
      this.stopping.signal.removeEventListener("abort", onStop);
    }

    this.checkRunning();

    const opmlResult = await opmlSync(
      { _tag: "FeedXmlCreated", path: join(this.ctx.config.dataPath, OPML_FILE) },
      {
        config: this.ctx.config,
        logger: this.ctx.logger,
        fs: guardFileSystem(this.ctx.fs, () => this.checkRunning()),
      },
    );

    if (opmlResult.isErr()) throw opmlResult.error;
    this.checkRunning();

    this.ctx.logger.info(logTag, "Published", {
      entries_count: events.length,
      duration_ms: Date.now() - startTime,
    });
  }

  private checkRunning(): void {
    this.stopping.signal.throwIfAborted();
  }

  shutdown(timeoutMs = 8_000): Promise<"completed" | "deadline"> {
    if (this.shutdownTask) return this.shutdownTask;
    this.admissionReady = false;
    this.publicationReady = false;
    const inactive = this.ctx.queue.stop();
    this.stopping.abort(new Error("Application stopping"));
    this.ctx.logger.info("Lifecycle", "Stopping");
    this.shutdownTask = this.finishShutdown(inactive, timeoutMs);

    return this.shutdownTask;
  }

  private async finishShutdown(
    inactive: Promise<void>,
    timeoutMs: number,
  ): Promise<"completed" | "deadline"> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        Promise.allSettled([
          inactive,
          this.activePass,
          this.consumerTask,
          this.reconciliationTask,
        ]).then(() => "completed" as const),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => {
            this.ctx.queue.expire();
            resolve("deadline");
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
