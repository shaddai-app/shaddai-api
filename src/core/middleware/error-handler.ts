import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../http/errors.js';
import { logger } from '../logger.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND' } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: err.issues } });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2025: el registro no existe o no es de la cuenta (el filtro tenant lo excluyó): mismo 404.
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'NOT_FOUND' } });
      return;
    }
    if (err.code === 'P2002') {
      res.status(409).json({ error: { code: 'CONFLICT_UNIQUE', details: { target: err.meta?.target } } });
      return;
    }
  }
  logger.error({ err, requestId: req.id }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
};
