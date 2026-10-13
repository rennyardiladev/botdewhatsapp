export interface QueueMetrics {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

interface Task<T> {
  tenantId: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
}

export class TenantQueue {
  private readonly queues = new Map<string, Task<unknown>[]>();
  private readonly runningByTenant = new Map<string, number>();
  private totalRunning = 0;
  private totalPending = 0;
  private completed = 0;
  private failed = 0;
  private draining = false;

  constructor(
    private readonly concurrency = 8,
    private readonly perTenantConcurrency = 1,
    private readonly maxPendingPerTenant = 100
  ) {
    if (concurrency < 1 || perTenantConcurrency < 1 || maxPendingPerTenant < 1) {
      throw new Error('Los límites de TenantQueue deben ser mayores que cero');
    }
  }

  enqueue<T>(tenantId: string, run: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(tenantId) ?? [];
    if (queue.length >= this.maxPendingPerTenant) {
      return Promise.reject(new Error(`Cola llena para tenant ${tenantId}`));
    }
    return new Promise<T>((resolve, reject) => {
      queue.push({ tenantId, run, resolve, reject, enqueuedAt: Date.now() } as Task<unknown>);
      this.queues.set(tenantId, queue);
      this.totalPending++;
      this.drain();
    });
  }

  metrics(): QueueMetrics {
    return { pending: this.totalPending, running: this.totalRunning, completed: this.completed, failed: this.failed };
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.totalRunning < this.concurrency) {
        const candidate = this.nextEligible();
        if (!candidate) break;
        const queue = this.queues.get(candidate.tenantId)!;
        queue.shift();
        this.totalPending--;
        if (queue.length === 0) this.queues.delete(candidate.tenantId);
        this.totalRunning++;
        this.runningByTenant.set(candidate.tenantId, (this.runningByTenant.get(candidate.tenantId) ?? 0) + 1);
        void candidate.run().then((value) => {
          this.completed++;
          candidate.resolve(value);
        }, (error) => {
          this.failed++;
          candidate.reject(error);
        }).finally(() => {
          this.totalRunning--;
          const next = (this.runningByTenant.get(candidate.tenantId) ?? 1) - 1;
          if (next <= 0) this.runningByTenant.delete(candidate.tenantId);
          else this.runningByTenant.set(candidate.tenantId, next);
          this.drain();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private nextEligible(): Task<unknown> | undefined {
    for (const [tenantId, queue] of this.queues) {
      if (queue.length && (this.runningByTenant.get(tenantId) ?? 0) < this.perTenantConcurrency) {
        return queue[0];
      }
    }
    return undefined;
  }
}