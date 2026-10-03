import { describe, expect, it } from 'vitest';
import { generateRecoveryCode, hashRecoveryCode, normalizeRecoveryCode } from './recovery-codes.js';

describe('códigos de recuperación', () => {
  it('formato legible, sin caracteres ambiguos y distintos entre sí', () => {
    const codes = Array.from({ length: 200 }, generateRecoveryCode);
    for (const code of codes) expect(code).toMatch(/^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('acepta lo que tipea la gente: mayúsculas, espacios, con o sin guion', () => {
    expect(normalizeRecoveryCode(' ABCD-2345 ')).toBe('abcd-2345');
    expect(normalizeRecoveryCode('abcd2345')).toBe('abcd-2345');
    expect(normalizeRecoveryCode('abcd 2345')).toBe('abcd-2345');
    expect(normalizeRecoveryCode('123456')).toBeNull(); // un código TOTP no es de recuperación
    expect(normalizeRecoveryCode('abcd-23')).toBeNull();
  });

  it('se guarda solo el hash', () => {
    expect(hashRecoveryCode('abcd-2345')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode('abcd-2345')).toBe(hashRecoveryCode('abcd-2345'));
  });
});
