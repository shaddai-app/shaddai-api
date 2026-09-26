import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword, hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('hashea con argon2id y verifica', async () => {
    const hash = await hashPassword('una-contraseña-larga');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'una-contraseña-larga')).toBe(true);
    expect(await verifyPassword(hash, 'otra')).toBe(false);
  });

  it('genera contraseñas temporales sin caracteres ambiguos y con variedad', () => {
    for (let i = 0; i < 200; i++) {
      const p = generateTemporaryPassword();
      expect(p).toHaveLength(16);
      expect(p).not.toMatch(/[0O1lI]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[2-9]/);
    }
  });
});
