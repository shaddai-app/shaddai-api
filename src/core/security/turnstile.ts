import { env } from '../../config/env.js';
import { logger } from '../logger.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verifica el token de Cloudflare Turnstile de un formulario público. Sin TURNSTILE_SECRET (solo
 * permitido fuera de producción, ver env.ts) no hay verificación. Si Cloudflare no responde se
 * rechaza: preferimos perder un envío a abrir la puerta a bots.
 */
export async function verifyTurnstile(token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (!data.success) logger.info({ codes: data['error-codes'] }, 'Turnstile rechazó el token');
    return data.success === true;
  } catch (err) {
    logger.warn({ err }, 'No se pudo verificar Turnstile');
    return false;
  }
}
