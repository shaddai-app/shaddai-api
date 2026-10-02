import type { ClientRateLimitInfo, IncrementResponse, Options, Store } from 'express-rate-limit';
import { prisma } from './prisma.js';

interface HitRow {
  hits: number;
  resetAt: Date;
}

/**
 * Store de express-rate-limit en SQL Server: con varias instancias de la API, todas cuentan sobre la
 * misma fila. El incremento es un MERGE atómico y usa la hora de la base, no la de cada instancia.
 */
export class DbRateLimitStore implements Store {
  localKeys = false;
  private windowMs = 60_000;

  constructor(readonly prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`.slice(0, 200);
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    const rows = await prisma.$queryRaw<HitRow[]>`
      SELECT hits, resetAt FROM RateLimitHit WHERE [key] = ${this.key(key)} AND resetAt > SYSUTCDATETIME()`;
    const row = rows[0];
    return row ? { totalHits: row.hits, resetTime: row.resetAt } : undefined;
  }

  async increment(key: string): Promise<IncrementResponse> {
    // HOLDLOCK: dos golpes simultáneos sobre una clave nueva no insertan dos veces.
    const rows = await prisma.$queryRaw<HitRow[]>`
      MERGE RateLimitHit WITH (HOLDLOCK) AS t
      USING (SELECT ${this.key(key)} AS k) AS s ON t.[key] = s.k
      WHEN MATCHED THEN UPDATE SET
        hits = CASE WHEN t.resetAt <= SYSUTCDATETIME() THEN 1 ELSE t.hits + 1 END,
        resetAt = CASE WHEN t.resetAt <= SYSUTCDATETIME()
          THEN DATEADD(millisecond, ${this.windowMs}, SYSUTCDATETIME()) ELSE t.resetAt END
      WHEN NOT MATCHED THEN
        INSERT ([key], hits, resetAt) VALUES (s.k, 1, DATEADD(millisecond, ${this.windowMs}, SYSUTCDATETIME()))
      OUTPUT inserted.hits, inserted.resetAt;`;
    const row = rows[0]!;
    return { totalHits: row.hits, resetTime: row.resetAt };
  }

  async decrement(key: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE RateLimitHit SET hits = hits - 1 WHERE [key] = ${this.key(key)} AND hits > 0`;
  }

  async resetKey(key: string): Promise<void> {
    await prisma.$executeRaw`DELETE FROM RateLimitHit WHERE [key] = ${this.key(key)}`;
  }
}

/** Borra los contadores vencidos (los llama el programador de procesos). */
export async function purgeExpiredRateLimits(): Promise<number> {
  return prisma.$executeRaw`DELETE FROM RateLimitHit WHERE resetAt <= SYSUTCDATETIME()`;
}
