import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
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
  logger.error({ err, requestId: req.id }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
};
