import DatabaseSync from 'better-sqlite3';
import type { TenantConfig, BotStatus } from '../types.js';
import type { TenantRecord } from '../core/TenantInstance.js';

export interface StoredMessage {
  tenantId: string;
  jid: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  messageId: string | null;
}

export interface StoredFlow {
  id: number;
  tenantId: string;
  trigger: string;
  response: string;
  exact: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
}

export class Database {
  private readonly db: DatabaseSync.Database;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_status (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'stopped',
        details_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        jid TEXT NOT NULL,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        message_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL,
        response TEXT NOT NULL,
        exact INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_tenant_created ON messages(tenant_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_tenant_jid ON messages(tenant_id, jid);
      CREATE INDEX IF NOT EXISTS idx_flows_tenant_sort ON tenant_flows(tenant_id, sort_order);
    `);
  }

  createTenant(id: string, name: string, config: TenantConfig): TenantRecord {
    const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO tenants (id, name, config_json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, JSON.stringify(config), createdAt);
    this.setStatus(id, 'stopped');
    return { id, name, config, createdAt };
  }

  listTenants(): TenantRecord[] {
    const rows = this.db.prepare('SELECT id, name, config_json, created_at FROM tenants ORDER BY created_at').all() as Array<{
      id: string; name: string; config_json: string; created_at: string
    }>;
    return rows.map((row) => ({ id: row.id, name: row.name, config: JSON.parse(row.config_json) as TenantConfig, createdAt: row.created_at }));
  }

  getTenant(id: string): TenantRecord | undefined {
    const row = this.db.prepare('SELECT id, name, config_json, created_at FROM tenants WHERE id = ?').get(id) as {
      id: string; name: string; config_json: string; created_at: string
    } | undefined;
    return row ? { id: row.id, name: row.name, config: JSON.parse(row.config_json) as TenantConfig, createdAt: row.created_at } : undefined;
  }

  setStatus(id: string, status: BotStatus | string, details?: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO tenant_status (tenant_id, status, details_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET status=excluded.status, details_json=excluded.details_json, updated_at=excluded.updated_at
    `).run(id, status, details ? JSON.stringify(details) : null, new Date().toISOString());
  }

  getStatus(id: string): string | undefined {
    const row = this.db.prepare('SELECT status FROM tenant_status WHERE tenant_id = ?').get(id) as { status: string } | undefined;
    return row?.status;
  }

  saveMessage(message: StoredMessage): void {
    this.db.prepare(`
      INSERT INTO messages (tenant_id, jid, direction, text, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(message.tenantId, message.jid, message.direction, message.text.slice(0, 10000), message.messageId, new Date().toISOString());
  }

  getRecentMessages(tenantId: string, limit = 50): unknown[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return this.db.prepare(`
      SELECT jid, direction, text, message_id AS messageId, created_at AS createdAt
      FROM messages WHERE tenant_id = ? ORDER BY id DESC LIMIT ?
    `).all(tenantId, safeLimit);
  }

   deleteTenant(id: string): boolean {
    return this.db.prepare('DELETE FROM tenants WHERE id = ?').run(id).changes > 0;
  }

   createFlow(input: {
     tenantId: string;
     trigger: string;
     response: string;
     exact?: boolean;
     enabled?: boolean;
   }): StoredFlow {
     const createdAt = new Date().toISOString();
     const sortOrder = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tenant_flows WHERE tenant_id = ?').get(input.tenantId) as { sort_order?: number } | undefined;
     const info = this.db.prepare(
       'INSERT INTO tenant_flows (tenant_id, trigger, response, exact, enabled, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
     ).run(
       input.tenantId,
       input.trigger,
       input.response,
       input.exact ? 1 : 0,
       input.enabled !== false ? 1 : 0,
       sortOrder?.sort_order ?? 1,
       createdAt
     );
     return {
       id: info.lastInsertRowid as number,
       tenantId: input.tenantId,
       trigger: input.trigger,
       response: input.response,
       exact: input.exact ?? false,
       enabled: input.enabled !== false,
       sortOrder: sortOrder?.sort_order ?? 1,
       createdAt
     };
   }

   listFlows(tenantId: string): StoredFlow[] {
     const rows = this.db.prepare(
       'SELECT id, tenant_id, trigger, response, exact, enabled, sort_order, created_at FROM tenant_flows WHERE tenant_id = ? ORDER BY sort_order, id'
     ).all(tenantId) as Array<{
       id: number; tenant_id: string; trigger: string; response: string;
       exact: number; enabled: number; sort_order: number; created_at: string
     }>;
     return rows.map(r => ({
       id: r.id, tenantId: r.tenant_id, trigger: r.trigger, response: r.response,
       exact: !!r.exact, enabled: !!r.enabled, sortOrder: r.sort_order, createdAt: r.created_at
     }));
   }

   updateFlow(id: number, fields: Partial<StoredFlow>): boolean {
     const flow = this.db.prepare('SELECT id FROM tenant_flows WHERE id = ?').get(id) as { id: number } | undefined;
     if (!flow) return false;
     if (fields.trigger !== undefined) {
       this.db.prepare('UPDATE tenant_flows SET trigger = ? WHERE id = ?').run(fields.trigger, id);
     }
     if (fields.response !== undefined) {
       this.db.prepare('UPDATE tenant_flows SET response = ? WHERE id = ?').run(fields.response, id);
     }
     if (fields.exact !== undefined) {
       this.db.prepare('UPDATE tenant_flows SET exact = ? WHERE id = ?').run(fields.exact ? 1 : 0, id);
     }
     if (fields.enabled !== undefined) {
       this.db.prepare('UPDATE tenant_flows SET enabled = ? WHERE id = ?').run(fields.enabled ? 1 : 0, id);
     }
     return true;
   }

   deleteFlow(id: number): boolean {
     return this.db.prepare('DELETE FROM tenant_flows WHERE id = ?').run(id).changes > 0;
   }

   close(): void { this.db.close(); }
}