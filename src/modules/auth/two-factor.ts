import { env } from '../../config/env.js';
import {
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
} from '../../core/auth/recovery-codes.js';
import { decryptSecret, verifyTotp } from '../../core/auth/totp.js';
import { prisma } from '../../core/db/prisma.js';
import { logger } from '../../core/logger.js';
import { sendMail } from '../../core/mail/mailer.js';
import { resolveMailLocale, securityAlertMail, type SecurityEvent } from '../../core/mail/templates.js';

// Verificación en dos pasos: segundo factor (código de la app o de recuperación), códigos de
// recuperación y avisos por mail de los cambios.

/** Reemplaza los códigos de recuperación del usuario y devuelve los nuevos (se muestran una sola vez). */
export async function issueRecoveryCodes(userId: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await prisma.$transaction([
    prisma.totpRecoveryCode.deleteMany({ where: { userId } }),
    prisma.totpRecoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
    }),
  ]);
  return codes;
}

export function recoveryCodesLeft(userId: number): Promise<number> {
  return prisma.totpRecoveryCode.count({ where: { userId, usedAt: null } });
}

/**
 * Valida el segundo factor: un código de 6 dígitos de la app o un código de recuperación, que queda
 * usado (la marca es atómica: el mismo código no entra dos veces aunque lleguen a la vez).
 */
export async function checkSecondFactor(
  user: { id: number; totpSecretEnc: string | null },
  input: string,
): Promise<'totp' | 'recovery' | null> {
  if (!user.totpSecretEnc) return null;
  const code = input.trim();
  if (/^\d{6}$/.test(code)) {
    return (await verifyTotp(decryptSecret(user.totpSecretEnc), code)) ? 'totp' : null;
  }
  const recovery = normalizeRecoveryCode(code);
  if (!recovery) return null;
  const { count } = await prisma.totpRecoveryCode.updateMany({
    where: { userId: user.id, codeHash: hashRecoveryCode(recovery), usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1 ? 'recovery' : null;
}

/** Mail de aviso de un cambio de seguridad. Un fallo del mail no frena la acción. */
export async function sendSecurityAlert(
  user: {
    id: number;
    email: string;
    firstName: string;
    locale: string | null;
    account?: { defaultLocale: string } | null;
  },
  event: SecurityEvent,
): Promise<void> {
  try {
    const left = event === 'recovery_code_used' ? await recoveryCodesLeft(user.id) : undefined;
    const mail = securityAlertMail(resolveMailLocale(user.locale, user.account?.defaultLocale), {
      name: user.firstName,
      event,
      recoveryCodesLeft: left,
      url: `${env.APP_URL}/configuracion/seguridad`,
    });
    await sendMail({ to: user.email, ...mail });
  } catch (err) {
    logger.error({ err, userId: user.id, event }, 'security alert mail failed');
  }
}
