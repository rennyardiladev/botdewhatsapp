import { performance } from 'node:perf_hooks';
import { TenantQueue } from '../src/core/TenantQueue.js';

const tenants = Number(process.env.LOAD_TENANTS ?? 10);
const jobsPerTenant = Number(process.env.LOAD_JOBS_PER_TENANT ?? 100);
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 8);
const queue = new TenantQueue(concurrency, 1, Math.max(jobsPerTenant, 100));
const latencies: number[] = [];
const started = performance.now();

const work: Promise<unknown>[] = [];
for (let tenant = 0; tenant < tenants; tenant++) {
  for (let job = 0; job < jobsPerTenant; job++) {
    const enqueuedAt = performance.now();
    work.push(queue.enqueue(`tenant-${tenant}`, async () => {
      // Trabajo sintético pequeño: no crea conexiones ni simula Baileys.
      await new Promise<void>((resolve) => setImmediate(resolve));
      latencies.push(performance.now() - enqueuedAt);
    }));
  }
}

await Promise.all(work);
const elapsed = performance.now() - started;
latencies.sort((a, b) => a - b);
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
console.log({
  tenants,
  jobs: tenants * jobsPerTenant,
  elapsedMs: Math.round(elapsed),
  jobsPerSecond: Math.round((tenants * jobsPerTenant) / (elapsed / 1000)),
  latencyP50Ms: Math.round(percentile(0.50) * 100) / 100,
  latencyP95Ms: Math.round(percentile(0.95) * 100) / 100,
  latencyP99Ms: Math.round(percentile(0.99) * 100) / 100,
  queue: queue.metrics()
});
