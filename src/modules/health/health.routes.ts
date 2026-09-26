import { Router } from 'express';
import { pingDatabase } from '../../core/db/prisma.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

healthRouter.get('/health/ready', async (_req, res) => {
  const db = await pingDatabase();
  res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded', checks: { db } });
});
