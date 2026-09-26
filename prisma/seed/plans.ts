import type { PrismaClient } from '../../src/generated/prisma/client.js';

// Valores iniciales (decisión pendiente: precios definitivos). Editables desde el panel de plataforma.
const PLANS = [
  { code: 'basic', name: 'Básico', userLimit: 5, storageLimitMb: 1024, priceUsd: '15.00' },
  { code: 'standard', name: 'Estándar', userLimit: 15, storageLimitMb: 5120, priceUsd: '35.00' },
  { code: 'pro', name: 'Pro', userLimit: 40, storageLimitMb: 20480, priceUsd: '70.00' },
];

export async function seedPlans(prisma: PrismaClient) {
  for (const plan of PLANS) {
    // Solo crea: no pisa cambios hechos luego desde el panel.
    await prisma.plan.upsert({ where: { code: plan.code }, create: plan, update: {} });
  }
  console.log(`✔ Planes: ${PLANS.map((p) => p.code).join(', ')}`);
}
