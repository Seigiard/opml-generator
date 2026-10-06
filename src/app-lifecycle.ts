import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AppContext } from "./context.ts";
import { OPML_FILE } from "./constants.ts";
import { adaptSyncPlan } from "./effect/adapters/sync-plan-adapter.ts";
import { opmlSync } from "./effect/handlers/opml-sync.ts";
import { createSyncPlan, scanFiles } from "./scanner.ts";
import { adaptBooksEvent } from "./effect/adapters/books-adapter.ts";
import type { RawBooksEvent } from "./effect/types.ts";

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

  constructor(private readonly ctx: AppContext) {}

  markAdmissionReady(): void {
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

  async startReconciliation(
    signal: AbortSignal,
    wait: (ms: number, signal: AbortSignal) => Promise<void> = waitForInterval,
  ): Promise<void> {
    if (this.ctx.config.reconcileInterval <= 0) return;

    const intervalMs = this.ctx.config.reconcileInterval * 1000;
    let passTask: Promise<boolean> | undefined;

    try {
      while (!signal.aborted) {
        await wait(intervalMs, signal);

        if (signal.aborted) break;

        if (this.syncing) continue;

        passTask = this.runPublicationPass("Reconciliation");
      }
    } finally {
      await passTask;
    }
  }

  async runInitialSync(): Promise<boolean> {
    return this.runPublicationPass("InitialSync");
  }

  async runPublicationPass(logTag: string): Promise<boolean> {
    if (this.syncing) return false;

    this.syncing = true;

    try {
      await this.publishCurrentCatalog(logTag);
      this.publicationReady = true;

      return true;
    } catch (error) {
      this.ctx.logger.error(logTag, "Failed", error);

      return false;
    } finally {
      this.syncing = false;
    }
  }

  private async publishCurrentCatalog(logTag: string): Promise<void> {
    this.ctx.logger.info(logTag, "Starting");
    const startTime = Date.now();

    await this.ctx.fs.mkdir(this.ctx.config.dataPath, { recursive: true });

    const files = await scanFiles(this.ctx.config.filesPath);
    this.ctx.logger.info(logTag, "Audio files found", { audio_files_found: files.length });

    const plan = await createSyncPlan(files, this.ctx.config.dataPath);
    this.ctx.logger.info(logTag, "Sync plan created", {
      audio_files_process: plan.toProcess.length,
      audio_files_delete: plan.toDelete.length,
      folders_count: plan.folders.length,
    });

    const events = adaptSyncPlan(plan, this.ctx.config.filesPath);
    const passId = this.ctx.lifecycle.startPass();
    this.ctx.lifecycle.enqueueMany(this.ctx.queue, events, passId);
    await this.ctx.lifecycle.waitFor(passId);

    const opmlResult = await opmlSync(
      { _tag: "FeedXmlCreated", path: join(this.ctx.config.dataPath, OPML_FILE) },
      { config: this.ctx.config, logger: this.ctx.logger, fs: this.ctx.fs },
    );

    if (opmlResult.isErr()) throw opmlResult.error;

    this.ctx.logger.info(logTag, "Published", {
      entries_count: events.length,
      duration_ms: Date.now() - startTime,
    });
  }
}
