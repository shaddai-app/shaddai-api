import express from 'express';
import { rateLimit } from 'express-rate-limit';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DbRateLimitStore, purgeExpiredRateLimits } from '../../src/core/db/rate-limit-store.js';
import { prisma, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function storeWith(prefix: string, windowMs: number) {
  const store = new DbRateLimitStore(prefix);
  store.init({ windowMs } as Parameters<DbRateLimitStore['init']>[0]);
  return store;
}

describe('rate limit compartido en la base', () => {
  it('cuenta, descuenta, reinicia la ventana y borra la clave', async () => {
    const store = storeWith('t', 600);
    expect((await store.increment('1.2.3.4')).totalHits).toBe(1);
    const second = await store.increment('1.2.3.4');
    expect(second.totalHits).toBe(2);
    expect(second.resetTime!.getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect((await store.get('1.2.3.4'))?.totalHits).toBe(2);

    await store.decrement('1.2.3.4');
    expect((await store.get('1.2.3.4'))?.totalHits).toBe(1);
    // Otra IP y otro limitador (prefijo) cuentan aparte.
    expect((await store.increment('5.6.7.8')).totalHits).toBe(1);
    expect((await storeWith('otro', 600).increment('1.2.3.4')).totalHits).toBe(1);

    await pause(800); // pasó la ventana: el próximo golpe arranca de nuevo
    expect(await store.get('1.2.3.4')).toBeUndefined();
    expect((await store.increment('1.2.3.4')).totalHits).toBe(1);

    await store.resetKey('1.2.3.4');
    expect(await store.get('1.2.3.4')).toBeUndefined();
    // Quedan las dos claves vencidas (5.6.7.8 y otro:1.2.3.4): el programador las borra.
    expect(await purgeExpiredRateLimits()).toBe(2);
    expect(await prisma.rateLimitHit.count()).toBe(0);
  });

  it('golpes simultáneos no se pierden (dos instancias contra la misma fila)', async () => {
    const a = storeWith('login', 60_000);
    const b = storeWith('login', 60_000);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).increment('9.9.9.9')),
    );
    expect(results.map((r) => r.totalHits).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(await prisma.rateLimitHit.count()).toBe(1);
  });

  it('el límite se respeta entre instancias de la API', async () => {
    // Dos "instancias" con su propio middleware y store, como dos réplicas de la API.
    const instance = () => {
      const app = express();
      app.use(rateLimit({ windowMs: 60_000, limit: 3, store: new DbRateLimitStore('api'), validate: false }));
      app.get('/', (_req, res) => res.send('ok'));
      return app;
    };
    const [one, two] = [instance(), instance()];
    const statuses = [];
    for (const app of [one, two, one, two]) statuses.push((await request(app).get('/')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
