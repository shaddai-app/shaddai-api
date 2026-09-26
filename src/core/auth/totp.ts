import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { env } from '../../config/env.js';

const key = Buffer.from(env.TOTP_ENC_KEY, 'base64');

/** Cifra el secreto TOTP (AES-256-GCM) para que un dump de la DB no permita generar códigos. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(
    ':',
  );
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Formato de secreto TOTP inválido');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export function createTotpSecret(label: string) {
  const secret = generateSecret();
  return { secret, uri: generateURI({ issuer: 'Shaddai', label, secret }) };
}

/** Acepta el código del período actual ± 30 s (desfase de reloj del celular). */
export async function verifyTotp(secret: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const result = await verify({ secret, token: code, epochTolerance: 30 });
  return result.valid;
}
