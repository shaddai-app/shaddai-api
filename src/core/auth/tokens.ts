import { createHash, randomBytes } from 'node:crypto';

/** Token opaco de 256 bits (refresh, reset de contraseña). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** En la DB solo se guarda el hash: una filtración de la tabla no expone tokens usables. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
