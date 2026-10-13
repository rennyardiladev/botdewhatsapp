import { BotCore } from './BotCore.js';
import { FlowManager, type FlowRule } from './FlowManager.js';
import type { BotStatus, TenantConfig } from '../types.js';
import type { Database } from '../database/Database.js';
import type { TenantQueue } from './TenantQueue.js';

export interface TenantRecord {
  id: string;
  name: string;
  config: TenantConfig;
  createdAt: string;
}

export class TenantInstance {
  readonly core: BotCore;
  constructor(
    readonly tenant: TenantRecord,
    authRoot: string,
    private readonly db: Database,
    queue: TenantQueue,
    logLevel = 'silent'
  ) {
    this.core = new BotCore({
      tenantId: tenant.id,
      authRoot,
      ignoreGroups: tenant.config.ignoreGroups,
      autoRejectCalls: tenant.config.autoRejectCalls,
      callRejectMessage: tenant.config.callRejectMessage,
      logLevel,
      onStatus: (status, details) => db.setStatus(tenant.id, status, details),
      enqueueMessage: (tenantId, task) => queue.enqueue(tenantId, task)
    });

    this.core.onOutgoing(async (tenantId, jid, content) => {
      const text = typeof content === 'object' && content !== null && 'text' in content
        ? String((content as { text?: unknown }).text ?? '')
        : '';
      db.saveMessage({ tenantId, jid, direction: 'outgoing', text, messageId: null });
    });
    this.core.onMessage(async (_sock, msg, helpers) => {
      const jid = msg.key.remoteJid;
      if (!jid) return false;
      db.saveMessage({
        tenantId: tenant.id,
        jid,
        direction: 'incoming',
        text: helpers.getText(),
        messageId: msg.key.id ?? null
      });
      return false;
    });

    void new FlowManager(() => this.rules).setup(this.core);
  }

  private get rules(): FlowRule[] {
    return this.db.listFlows(this.tenant.id).map(f => ({
      trigger: f.trigger,
      response: f.response,
      exact: f.exact,
      enabled: f.enabled
    }));
  }

  start(): Promise<void> { return this.core.start(); }
  stop(): Promise<void> { return this.core.stop(); }
  status(): BotStatus { return this.core.getStatus(); }
  qr(): string | null { return this.core.getQr(); }
}