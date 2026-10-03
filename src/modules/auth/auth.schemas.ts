import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '../../core/auth/password-policy.js';

const email = z.string().trim().toLowerCase().pipe(z.email().max(150));

// La fortaleza se valida aparte (assertStrongPassword) para devolver feedback útil.
const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);

export const LoginSchema = z.object({
  email,
  password,
  rememberMe: z.boolean().default(false),
});

/** Ingreso a la demo: solo el perfil; el mail sale de DEMO_USERS en el servidor. */
export const DemoLoginSchema = z
  .object({ role: z.enum(['admin', 'pastor', 'treasurer', 'cell_leader']) })
  .strict();

export const TwoFactorVerifySchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().trim().max(20), // 6 dígitos de la app o un código de recuperación
});

export const ChangePasswordSchema = z.object({
  currentPassword: password,
  newPassword: password,
});

export const ForgotPasswordSchema = z.object({ email });

export const ResetPasswordSchema = z.object({
  token: z.string().min(20).max(100),
  newPassword: password,
});

export const TotpConfirmSchema = z.object({ code: z.string().trim() });

export const TotpDisableSchema = z.object({
  password: z.string().min(1).max(200),
  code: z.string().trim().min(1).max(20),
});

export const RecoveryCodesSchema = z.object({ password: z.string().min(1).max(200) });
