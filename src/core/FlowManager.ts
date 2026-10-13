import type { BotCore } from './BotCore.js';
import type { Plugin } from '../types.js';

export interface FlowRule {
  trigger: string;
  response: string;
  exact?: boolean;
  enabled?: boolean;
}

export class FlowManager implements Plugin {
  name = 'FlowManager';

  constructor(private readonly getRules: () => FlowRule[]) {}

  setup(bot: BotCore): void {
    bot.onMessage(async (sock, msg, helpers) => {
      const text = helpers.getText().trim();
      if (!text) return false;

      if (text.toLowerCase() === '!ayuda') {
        await sock.sendMessage(msg.key.remoteJid!, {
          text: '🤖 *Menú de ayuda*\n\n!ayuda - Ver comandos\nEscribe tu consulta para recibir atención.'
        });
        return true;
      }

      for (const rule of this.getRules()) {
        if (rule.enabled === false) continue;
        const input = text.toLocaleLowerCase();
        const trigger = rule.trigger.toLocaleLowerCase();
        const matched = rule.exact ? input === trigger : input.includes(trigger);
        if (!matched) continue;
        await sock.sendMessage(msg.key.remoteJid!, { text: rule.response });
        return true;
      }
      return false;
    });
  }
}