import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { createTotpSecret, decryptSecret, encryptSecret, verifyTotp } from './totp.js';

describe('totp', () => {
  it('cifra y descifra el secreto (IV distinto en cada cifrado)', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP');
    const b = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('detecta un secreto cifrado alterado', () => {
    const [v, iv, tag, data] = encryptSecret('JBSWY3DPEHPK3PXP').split(':');
    const tampered = [v, iv, tag, Buffer.from('otro-contenido').toString('base64')].join(':');
    expect(() => decryptSecret(tampered)).toThrow();
    expect(data).toBeTruthy();
  });

  it('verifica códigos válidos y rechaza formatos inválidos', async () => {
    const { secret, uri } = createTotpSecret('ana@test.local');
    expect(uri).toContain('issuer=Shaddai');
    expect(await verifyTotp(secret, await generate({ secret }))).toBe(true);
    expect(await verifyTotp(secret, '12345')).toBe(false);
    expect(await verifyTotp(secret, 'abcdef')).toBe(false);
  });
});
