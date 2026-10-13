import 'dotenv/config';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Database } from './database/Database.js';
import { TenantManager } from './core/TenantManager.js';
import { TenantQueue } from './core/TenantQueue.js';
import { createHttpApp } from './http.js';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
await mkdir(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'saas.sqlite'));
const queue = new TenantQueue(8, 1, 100);
const tenantManager = new TenantManager(db, dataDir, queue, process.env.LOG_LEVEL ?? 'silent');

await tenantManager.init();

const apiToken = process.env.API_TOKEN ?? '';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const app = createHttpApp({ tenantManager, db, apiToken, queue });
const server = app.listen(port, host, () => {
  console.log(`API disponible en http://${host}:${port}`);
  console.log('Health: /health | API administrativa: /api');
  console.log('Las sesiones no se inician automáticamente; usa POST /api/tenants/:id/start.');
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Recibida señal ${signal}; cerrando...`);
  server.close();
  await tenantManager.stopAll();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
