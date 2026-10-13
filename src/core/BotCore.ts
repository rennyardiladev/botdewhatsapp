import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type WAMessage,
  type ConnectionState
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BotStatus, MessageHandler, CallHandler, OutgoingHandler, Plugin } from '../types.js';
import { BotHelpers } from '../types.js';

export interface BotCoreOptions {
  tenantId: string;
  authRoot: string;
  ignoreGroups?: boolean;
  autoRejectCalls?: boolean;
  callRejectMessage?: string;
  logLevel?: string;
  onStatus?: (status: BotStatus, details?: Record<string, unknown>) => void;
  enqueueMessage?: (tenantId: string, task: () => Promise<void>) => Promise<void>;
}

export class BotCore {
  private sock: WASocket | null = null;
  private readonly messageHandlers: MessageHandler[] = [];
  private readonly callHandlers: CallHandler[] = [];
  private readonly outgoingHandlers: OutgoingHandler[] = [];
  private status: BotStatus = 'stopped';
  private lastQr: string | null = null;
  private startPromise: Promise<void> | null = null;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private saveCreds: (() => Promise<void>) | null = null;

  constructor(private readonly options: BotCoreOptions) {}

  onMessage(handler: MessageHandler): void { this.messageHandlers.push(handler); }
  onCall(handler: CallHandler): void { this.callHandlers.push(handler); }
  onOutgoing(handler: OutgoingHandler): void { this.outgoingHandlers.push(handler); }
  getSocket(): WASocket | null { return this.sock; }
  getStatus(): BotStatus { return this.status; }
  getQr(): string | null { return this.lastQr; }

  private setStatus(status: BotStatus, details?: Record<string, unknown>): void {
    this.status = status;
    this.options.onStatus?.(status, details);
  }

  async start(): Promise<void> {
    if (this.status === 'open' || this.status === 'waiting_qr') return;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.connectOnce().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  private async connectOnce(): Promise<void> {
    const myGeneration = ++this.generation;
    this.setStatus('starting');
    const authFolder = path.join(this.options.authRoot, this.options.tenantId);
    await mkdir(authFolder, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    this.saveCreds = saveCreds;

    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: this.options.logLevel ?? 'silent' }),
      browser: ['MultiTenant-SaaS', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      retryRequestDelayMs: 250
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      void saveCreds().catch((error) => console.error(`[${this.options.tenantId}] Error guardando credenciales`, error));
    });

    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      if (myGeneration !== this.generation) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.lastQr = qr;
        void QRCode.toDataURL(qr).then(url => { this.lastQr = url; }).catch(err => console.error(`[${this.options.tenantId}] Error generando data URL del QR`, err));
        this.setStatus('waiting_qr');
        console.log(`\n[${this.options.tenantId}] Escanea este QR en WhatsApp > Dispositivos vinculados`);
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        this.reconnectAttempt = 0;
        this.lastQr = null;
        this.setStatus('open');
        console.log(`[${this.options.tenantId}] WhatsApp conectado`);
      }
      if (connection === 'close') {
        this.sock = null;
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.lastQr = null;
        this.setStatus(loggedOut ? 'logged_out' : 'closed', { code });
        if (!this.stopping && !loggedOut) this.scheduleReconnect();
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (myGeneration !== this.generation || type !== 'notify') return;
      for (const msg of messages) {
        if (myGeneration !== this.generation) return;
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith('@broadcast')) continue;
        if ((this.options.ignoreGroups ?? true) && jid.endsWith('@g.us')) continue;
        const processMessage = async () => {
          const helpers = new BotHelpers(msg);
          for (const handler of this.messageHandlers) {
            try {
              const handled = await handler(sock, msg, helpers);
              if (handled === true) break;
            } catch (error) {
              console.error(`[${this.options.tenantId}] Error en handler:`, error);
              break;
            }
          }
        };
        try {
          if (this.options.enqueueMessage) {
            await this.options.enqueueMessage(this.options.tenantId, processMessage);
          } else {
            await processMessage();
          }
        } catch (error) {
          console.error(`[${this.options.tenantId}] Error procesando mensaje en cola:`, error);
        }
      }
    });

    sock.ev.on('call', async (calls) => {
      for (const call of calls) {
        for (const handler of this.callHandlers) {
          try { await handler(sock, call); }
          catch (error) { console.error(`[${this.options.tenantId}] Error en handler de llamada`, error); }
        }
        if ((this.options.autoRejectCalls ?? true) && (call as { status?: string }).status === 'offer') {
          try {
            await sock.rejectCall((call as { id: string }).id, (call as { from: string }).from);
            await sock.sendMessage((call as { from: string }).from, {
              text: this.options.callRejectMessage ??
                'Este número utiliza un asistente automatizado. Por favor, escribe tu consulta.'
            });
          } catch (error) {
            console.error(`[${this.options.tenantId}] Error rechazando llamada`, error);
          }
        }
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectAttempt++;
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    const jitter = Math.floor(Math.random() * 500);
    const delay = base + jitter;
    console.log(`[${this.options.tenantId}] Reconexión en ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) void this.start().catch((error) => {
        console.error(`[${this.options.tenantId}] Error reconectando`, error);
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  async sendMessage(jid: string, content: Parameters<WASocket['sendMessage']>[1]): Promise<unknown> {
    if (!this.sock || this.status !== 'open') throw new Error('La sesión de WhatsApp no está conectada');
    const result = await this.sock.sendMessage(jid, content);
    for (const handler of this.outgoingHandlers) {
      try { await handler(this.options.tenantId, jid, content); }
      catch (error) { console.error(`[${this.options.tenantId}] Error onOutgoing`, error); }
    }
    return result;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const sock = this.sock;
    this.sock = null;
    this.lastQr = null;
    if (sock) {
      try { sock.end(undefined); } catch { /* best effort */ }
    }
    this.setStatus('stopped');
  }
}