import type { MissionStep } from "../../shared/types";

export interface DagCallbacks {
  run(step: MissionStep): Promise<void>;
  isCancelled(): boolean;
  onSkip(step: MissionStep, reason: string): void;
}

/**
 * Ejecuta los pasos respetando dependencias. Los nodos independientes corren en paralelo.
 * Los nodos `writes` se serializan con un mutex (un solo agente edita el worktree a la vez).
 */
export class MissionDagExecutor {
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private steps: MissionStep[], private cb: DagCallbacks) {}

  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release!: () => void;
    this.writeLock = new Promise<void>((r) => (release = r));
    return prev.then(fn).finally(() => release());
  }

  async execute(): Promise<{ failed: MissionStep[] }> {
    const byId = new Map(this.steps.map((s) => [s.id, s]));
    const done = new Set<string>(this.steps.filter((s) => s.status === "done").map((s) => s.id));
    const failed: MissionStep[] = [];
    const running = new Map<string, Promise<void>>();

    const ready = () =>
      this.steps.filter(
        (s) => s.status === "pending" && !running.has(s.id) && s.dependsOn.every((d) => done.has(d) || !byId.has(d)),
      );
    const blockedByFailure = (s: MissionStep): boolean =>
      s.dependsOn.some((d) => {
        const dep = byId.get(d);
        return !!dep && (dep.status === "failed" || dep.status === "skipped" || dep.status === "cancelled");
      });

    for (;;) {
      if (this.cb.isCancelled()) break;
      for (const s of this.steps) {
        if (s.status === "pending" && blockedByFailure(s)) {
          s.status = "skipped";
          this.cb.onSkip(s, "Dependencia fallida");
        }
      }
      for (const s of ready()) {
        const p = (s.writes ? this.withWriteLock(() => this.cb.run(s)) : this.cb.run(s))
          .then(() => {
            if (s.status === "done") done.add(s.id);
            else if (s.status === "failed") failed.push(s);
          })
          .catch(() => {
            s.status = "failed";
            failed.push(s);
          })
          .finally(() => running.delete(s.id));
        running.set(s.id, p);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());
    return { failed };
  }
}
