import axios from 'axios';

/**
 * Cloudflare Turnstile — validação server-side do token enviado no cadastro.
 * SKIP_CAPTCHA=true: apenas desenvolvimento local.
 * Em produção: defina TURNSTILE_SECRET_KEY.
 */
export async function verifyRegistrationCaptcha(
  token: string | undefined,
  remoteip?: string
): Promise<void> {
  if (process.env.SKIP_CAPTCHA === 'true') {
    return;
  }

  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Captcha nao configurado no servidor.');
    }
    console.warn('[captcha] TURNSTILE_SECRET_KEY ausente — verificacao ignorada (ambiente nao-producao).');
    return;
  }

  const response = String(token || '').trim();
  if (!response) {
    throw new Error('Confirme que voce nao e um robo (complete o CAPTCHA).');
  }

  const params = new URLSearchParams();
  params.append('secret', secret);
  params.append('response', response);
  if (remoteip) {
    params.append('remoteip', remoteip);
  }

  const { data } = await axios.post<{
    success: boolean;
    'error-codes'?: string[];
  }>('https://challenges.cloudflare.com/turnstile/v0/siteverify', params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10_000,
  });

  if (!data.success) {
    throw new Error('Nao foi possivel validar o cadastro. Atualize o CAPTCHA e tente novamente.');
  }
}
