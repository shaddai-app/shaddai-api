import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeRefreshTokens } from '../../src/jobs/scheduler.js';
import { purgeExpiredRefreshTokens } from '../../src/modules/auth/session.service.js';
import { app, prisma, provisionChurch, resetDb } from './helpers.js';
import request from 'supertest';

const DAY = 86_400_000;
const now = new Date('2026-10-03T12:00:00Z');

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

/** Una familia de refresh tokens: el vigente y uno rotado, con el mismo vencimiento (como la rotación). */
async function family(userId: number, expiresAt: Date) {
  const familyId = randomUUID();
  const base = { userId, familyId, expiresAt };
  await prisma.refreshToken.create({
    data: { ...base, tokenHash: randomBytes(32).toString('hex'), revokedAt: now, revokedReason: 'rotated' },
  });
  await prisma.refreshToken.create({
    data: { ...base, tokenHash: randomBytes(32).toString('hex') },
  });
  return familyId;
}

describe('purga de refresh tokens', () => {
  it('borra las familias vencidas hace más de una semana y deja el resto', async () => {
    const church = await provisionChurch();
    const old = await family(church.ownerId, new Date(now.getTime() - 8 * DAY));
    const recent = await family(church.ownerId, new Date(now.getTime() - 2 * DAY));
    const live = await family(church.ownerId, new Date(now.getTime() + 5 * DAY));

    const purged = await purgeExpiredRefreshTokens(now);
    expect(purged).toBe(2);

    const left = await prisma.refreshToken.findMany({ select: { familyId: true } });
    const families = new Set(left.map((t) => t.familyId));
    expect(families.has(old)).toBe(false);
    expect(families.has(recent)).toBe(true); // vencida hace poco: se conserva para investigar
    expect(families.has(live)).toBe(true);
  });

  it('no toca la sesión vigente: después de purgar, la cuenta sigue funcionando', async () => {
    const church = await provisionChurch();
    await family(church.ownerId, new Date(Date.now() - 30 * DAY));
    await purgeRefreshTokens();
    const res = await request(app).get('/api/v1/me').set(church.headers);
    expect(res.status).toBe(200);
    // Queda solo la sesión del login de provisionChurch.
    expect(await prisma.refreshToken.count()).toBeGreaterThan(0);
    expect(await prisma.refreshToken.count({ where: { expiresAt: { lt: new Date() } } })).toBe(0);
  });
});
