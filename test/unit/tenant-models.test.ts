import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHILD_MODELS, TENANT_EXEMPT_MODELS, TENANT_MODELS } from '../../src/core/db/tenant.js';

const schemaDir = join(import.meta.dirname, '../../prisma/schema');
const schema = readdirSync(schemaDir)
  .filter((f) => f.endsWith('.prisma'))
  .map((f) => readFileSync(join(schemaDir, f), 'utf8'))
  .join('\n');

const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(([, name, body]) => ({
  name: name!,
  body: body!,
}));

describe('cobertura del filtro multi-tenant', () => {
  it('todo modelo con accountId está filtrado o exento explícitamente', () => {
    const withAccountId = models.filter((m) => /^\s+accountId\s+Int\??/m.test(m.body)).map((m) => m.name);
    const uncovered = withAccountId.filter((n) => !TENANT_MODELS.has(n) && !TENANT_EXEMPT_MODELS.has(n));
    expect(uncovered, 'Agregá estos modelos a TENANT_MODELS en src/core/db/tenant.ts').toEqual([]);
  });

  it('todo modelo con FK a un modelo tenant y sin accountId está en CHILD_MODELS', () => {
    const tenantRefs = models.filter(
      (m) =>
        !/^\s+accountId\s+Int/m.test(m.body) &&
        [...TENANT_MODELS].some((t) => new RegExp(`^\\s+\\w+\\s+${t}\\??\\s+@relation`, 'm').test(m.body)) &&
        m.name !== 'Account',
    );
    const uncovered = tenantRefs.map((m) => m.name).filter((n) => !(n in CHILD_MODELS));
    expect(uncovered, 'Agregá estos modelos a CHILD_MODELS en src/core/db/tenant.ts').toEqual([]);
  });

  it('las listas apuntan a modelos que existen', () => {
    const names = new Set(models.map((m) => m.name));
    for (const n of [...TENANT_MODELS, ...Object.keys(CHILD_MODELS), ...TENANT_EXEMPT_MODELS]) {
      expect(names.has(n), n).toBe(true);
    }
  });
});
