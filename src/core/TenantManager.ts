import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Database, StoredFlow } from '../database/Database.js';
import type { TenantConfig } from '../types.js';
import type { TenantQueue } from './TenantQueue.js';
import { TenantInstance, type TenantRecord } from './TenantInstance.js';

export class TenantManager {
  private readonly instances = new Map<string, TenantInstance>();

  constructor(
    private readonly db: Database,
    private readonly dataDir: string,
    private readonly queue: TenantQueue,
    private readonly logLevel = 'silent'
  ) {}

  async init(): Promise<void> {
    await mkdir(path.join(this.dataDir, 'sessions'), { recursive: true });
    for (const row of this.db.listTenants()) {
      // No arrancar sesiones automáticamente por defecto; el operador las inicia explícitamente.
      this.db.setStatus(row.id, 'stopped');
    }
  }

  createTenant(input: { id: string; name: string; config?: TenantConfig }): TenantRecord {
    if (!/^[a-zA-Z0-9_-]{2,64}$/.test(input.id)) {
      throw new Error('El id debe tener 2-64 caracteres: letras, números, guion o guion bajo');
    }
    if (!input.name.trim()) throw new Error('El nombre es obligatorio');
    const config = input.config ?? {};
    const record = this.db.createTenant(input.id, input.name.trim(), config);
    return record;
  }

  listTenants(): Array<TenantRecord & { status: string }> {
    return this.db.listTenants().map((tenant) => ({
      ...tenant,
      status: this.instances.get(tenant.id)?.status() ?? this.db.getStatus(tenant.id) ?? 'stopped'
    }));
  }

  getTenant(id: string): TenantRecord | undefined {
    return this.db.getTenant(id);
  }

  async startTenant(id: string): Promise<void> {
    const tenant = this.db.getTenant(id);
    if (!tenant) throw new Error('Tenant no encontrado');
    const current = this.instances.get(id);
    if (current && ['starting', 'waiting_qr', 'open'].includes(current.status())) return;
    if (current) await current.stop();
    const instance = new TenantInstance(tenant, path.join(this.dataDir, 'sessions'), this.db, this.queue, this.logLevel);
    this.instances.set(id, instance);
    try {
      await instance.start();
    } catch (error) {
      this.instances.delete(id);
      throw error;
    }
  }

  async stopTenant(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (instance) {
      await instance.stop();
      this.instances.delete(id);
    }
    if (this.db.getTenant(id)) this.db.setStatus(id, 'stopped');
  }

   getStatus(id: string): { status: string; qr: string | null } | undefined {
    if (!this.db.getTenant(id)) return undefined;
    const instance = this.instances.get(id);
    return { status: instance?.status() ?? this.db.getStatus(id) ?? 'stopped', qr: instance?.qr() ?? null };
  }

   listFlows(id: string): StoredFlow[] | undefined {
     if (!this.db.getTenant(id)) return undefined;
     return this.db.listFlows(id);
   }

   createFlow(id: string, input: { trigger: string; response: string; exact?: boolean; enabled?: boolean }): StoredFlow {
     if (!this.db.getTenant(id)) throw new Error('Tenant no encontrado');
     return this.db.createFlow({ tenantId: id, ...input });
   }

   updateFlow(id: string, flowId: number, fields: { trigger?: string; response?: string; exact?: boolean; enabled?: boolean }): boolean {
     if (!this.db.getTenant(id)) throw new Error('Tenant no encontrado');
     const existing = this.db.listFlows(id).find(f => f.id === flowId);
     if (!existing) throw new Error('Flujo no encontrado');
     return this.db.updateFlow(flowId, fields);
   }

   deleteFlow(id: string, flowId: number): boolean {
     if (!this.db.getTenant(id)) throw new Error('Tenant no encontrado');
     return this.db.deleteFlow(flowId);
   }

  async deleteTenant(id: string): Promise<boolean> {
    await this.stopTenant(id);
    return this.db.deleteTenant(id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((id) => this.stopTenant(id)));
  }
}