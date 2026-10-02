import { describe, expect, it } from 'vitest';
import { ACCOUNT_DATA, exportFileName } from '../../src/core/db/account-data.js';
import { CHILD_MODELS, TENANT_MODELS } from '../../src/core/db/tenant.js';

describe('datos de una iglesia (exportación y purga)', () => {
  it('incluye todos los modelos de cuenta y sus hijos, una sola vez', () => {
    const listed = ACCOUNT_DATA.map((d) => d.model);
    const expected = [...TENANT_MODELS, ...Object.keys(CHILD_MODELS)];
    const missing = expected.filter((m) => !listed.includes(m));
    expect(missing, 'Agregá estos modelos a ACCOUNT_DATA en src/core/db/account-data.ts').toEqual([]);
    expect(listed.filter((m) => !expected.includes(m))).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('cada hijo se borra antes que sus padres', () => {
    const position = new Map(ACCOUNT_DATA.map((d, i) => [d.model, i]));
    for (const [child, relations] of Object.entries(CHILD_MODELS)) {
      for (const { parent } of Object.values(relations)) {
        expect(position.get(child)!, `${child} antes que ${parent}`).toBeLessThan(position.get(parent)!);
      }
    }
  });

  it('las credenciales y sesiones no se exportan', () => {
    const exported = new Set(ACCOUNT_DATA.filter((d) => d.export).map((d) => d.model));
    for (const m of ['RefreshToken', 'PasswordResetToken']) expect(exported.has(m), m).toBe(false);
  });

  it('nombres de archivo legibles', () => {
    expect(exportFileName('FinanceMovement')).toBe('finance-movement.json');
    expect(exportFileName('User')).toBe('user.json');
  });
});
