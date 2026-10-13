import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import type { BotCore } from './core/BotCore.js';

export type BotStatus = 'starting' | 'waiting_qr' | 'open' | 'closed' | 'logged_out' | 'stopped';

export interface TenantConfig {
  ignoreGroups?: boolean;
  autoRejectCalls?: boolean;
  callRejectMessage?: string;
}

export type MessageHandler = (
  sock: WASocket,
  msg: WAMessage,
  helpers: BotHelpers
) => Promise<void | boolean> | void | boolean;

export type CallHandler = (sock: WASocket, call: unknown) => Promise<void> | void;
export type OutgoingHandler = (tenantId: string, jid: string, content: unknown) => Promise<void> | void;

export interface Plugin {
  name: string;
  setup(bot: BotCore): void | Promise<void>;
}

export class BotHelpers {
  constructor(private readonly msg: WAMessage) {}

  getMessageType(): string | undefined {
    return Object.keys(this.msg.message ?? {})[0];
  }

  getText(): string {
    const m = this.msg.message;
    return m?.conversation ??
      m?.extendedTextMessage?.text ??
      m?.imageMessage?.caption ??
      m?.videoMessage?.caption ??
      m?.documentMessage?.caption ??
      '';
  }

  isAudio(): boolean {
    const type = this.getMessageType();
    return type === 'audioMessage' || type === 'pttMessage';
  }

  getTenantMessageId(): string | undefined {
    return this.msg.key.id;
  }
}