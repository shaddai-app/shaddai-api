import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addMonths } from '../../src/modules/billing/billing.service.js';
import { verifyMercadoPagoSignature } from '../../src/modules/billing/mercadopago.provider.js';

const SECRET = 'secreto-de-prueba';

/** Arma un aviso firmado como lo hace Mercado Pago. */
function signed(dataId: string, requestId = 'req-123', ts = '1704908010', secret = SECRET) {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac('sha256', secret).update(manifest).digest('hex');
  return {
    headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
    query: { 'data.id': dataId },
    body: {},
  };
}

describe('firma de los avisos de Mercado Pago', () => {
  it('acepta la firma correcta (id alfanumérico en minúsculas)', () => {
    expect(verifyMercadoPagoSignature(signed('123456'), SECRET, '123456')).toBe(true);
    expect(verifyMercadoPagoSignature(signed('AbC123'), SECRET, 'AbC123')).toBe(true);
  });

  it('rechaza otro secreto, otro id, otra request o cabeceras faltantes', () => {
    expect(verifyMercadoPagoSignature(signed('123', 'r', '1', 'otro'), SECRET, '123')).toBe(false);
    expect(verifyMercadoPagoSignature(signed('123'), SECRET, '124')).toBe(false);
    const req = signed('123');
    expect(
      verifyMercadoPagoSignature(
        { ...req, headers: { ...req.headers, 'x-request-id': 'otra' } },
        SECRET,
        '123',
      ),
    ).toBe(false);
    expect(verifyMercadoPagoSignature({ ...req, headers: {} }, SECRET, '123')).toBe(false);
    expect(
      verifyMercadoPagoSignature(
        { ...req, headers: { ...req.headers, 'x-signature': 'ts=1,v1=zz' } },
        SECRET,
        '123',
      ),
    ).toBe(false);
  });
});

describe('período pagado', () => {
  it('suma meses calendario sin pasarse de fin de mes', () => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    expect(iso(addMonths(new Date('2026-01-15T10:00:00Z'), 1))).toBe('2026-02-15');
    expect(iso(addMonths(new Date('2026-01-31T10:00:00Z'), 1))).toBe('2026-02-28');
    expect(iso(addMonths(new Date('2028-01-31T10:00:00Z'), 1))).toBe('2028-02-29');
    expect(iso(addMonths(new Date('2026-11-30T10:00:00Z'), 3))).toBe('2027-02-28');
    expect(addMonths(new Date('2026-03-10T15:30:00Z'), 1).toISOString()).toBe('2026-04-10T15:30:00.000Z');
  });
});
