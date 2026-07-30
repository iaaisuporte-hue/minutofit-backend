/**
 * Camada de e-mail transacional — abstração com Resend como provider padrão.
 *
 * Por que abstrair (mesma razão de `lib/storage`): a borda (provider/credencial)
 * deve ser trocável sem tocar nos services. Trocar de Resend p/ SES/SMTP no futuro
 * é implementar outro `EmailProvider` — os chamadores não mudam.
 *
 * DEGRADAÇÃO NÃO-SILENCIOSA (requisito explícito, igual storage): sem config, NÃO
 * falhamos mudo. Sem `RESEND_API_KEY`, `send()` NÃO lança — loga a mensagem (incl.
 * o link) em nível warn fora de produção, para o fluxo (ex.: reset de senha) ser
 * testável localmente sem enviar de verdade. Em produção sem config, loga error.
 * `isEmailConfigured()` alimenta `GET /api/health` como sinal visível.
 */
import { Resend } from 'resend';
import logger from '../logger';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  readonly name: string;
  isConfigured(): boolean;
  send(msg: EmailMessage): Promise<void>;
}

const FROM = process.env.EMAIL_FROM || 'noreply@s2core.com.br';

/** Provider Resend. */
class ResendProvider implements EmailProvider {
  readonly name = 'resend';
  private _client: Resend | null = null;
  private readonly apiKey = process.env.RESEND_API_KEY || '';

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private client(): Resend {
    if (!this._client) this._client = new Resend(this.apiKey);
    return this._client;
  }

  async send(msg: EmailMessage): Promise<void> {
    if (!this.isConfigured()) {
      // Degradação não-silenciosa: não envia, mas deixa rastro visível. Em dev, o
      // link do e-mail sai no log para o fluxo ser testável sem provider.
      const level = process.env.NODE_ENV === 'production' ? 'error' : 'warn';
      logger[level](
        { to: msg.to, subject: msg.subject, textPreview: msg.text.slice(0, 500) },
        '[email] RESEND_API_KEY ausente — e-mail NÃO enviado (degradação não-silenciosa)',
      );
      return;
    }
    const { error } = await this.client().emails.send({
      from: FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
    if (error) {
      logger.error({ err: error, to: msg.to, subject: msg.subject }, '[email] falha ao enviar via Resend');
      throw new Error(`Falha ao enviar e-mail: ${error.message}`);
    }
  }
}

const provider: EmailProvider = new ResendProvider();

export function isEmailConfigured(): boolean {
  return provider.isConfigured();
}

export function emailProviderName(): string {
  return provider.name;
}

/** Envia um e-mail transacional. Nunca lança quando o provider não está
 *  configurado (degradação não-silenciosa) — só lança em falha real de envio. */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  await provider.send(msg);
}

// ── Templates ──────────────────────────────────────────────────────────────

/** E-mail de redefinição de senha (HTML + texto). Copy S2CORE, sóbria. */
export function renderPasswordResetEmail(resetLink: string, expiresInMinutes: number): Omit<EmailMessage, 'to'> {
  const subject = 'Redefinição de senha — S2CORE';
  const text = [
    'Você pediu para redefinir sua senha no S2CORE.',
    '',
    `Abra o link abaixo para criar uma nova senha (válido por ${expiresInMinutes} minutos):`,
    resetLink,
    '',
    'Se não foi você, ignore este e-mail — sua senha continua a mesma.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="pt-BR"><body style="margin:0;background:#f6f7f4;font-family:Arial,Helvetica,sans-serif;color:#1f2421;">
  <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
    <h1 style="font-size:20px;margin:0 0 16px;">Redefinição de senha</h1>
    <p style="font-size:14px;line-height:1.6;margin:0 0 20px;">
      Você pediu para redefinir sua senha no <strong>S2CORE</strong>. Toque no botão
      abaixo para criar uma nova senha. O link vale por ${expiresInMinutes} minutos.
    </p>
    <p style="margin:0 0 24px;">
      <a href="${resetLink}" style="display:inline-block;background:#5E7412;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:700;font-size:14px;">Redefinir senha</a>
    </p>
    <p style="font-size:12px;line-height:1.6;color:#5b625c;margin:0 0 8px;">
      Se o botão não funcionar, copie e cole no navegador:<br>
      <span style="word-break:break-all;">${resetLink}</span>
    </p>
    <p style="font-size:12px;line-height:1.6;color:#5b625c;margin:16px 0 0;">
      Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma.
    </p>
  </div>
</body></html>`;

  return { subject, html, text };
}
