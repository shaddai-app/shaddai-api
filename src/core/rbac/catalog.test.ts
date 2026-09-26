import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './catalog.js';

describe('catálogo de permisos', () => {
  it('usa el formato modulo.accion y no tiene duplicados', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it('asigna sortOrder único y creciente', () => {
    const orders = PERMISSIONS.map((p) => p.sortOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(new Set(orders).size).toBe(orders.length);
  });
});
