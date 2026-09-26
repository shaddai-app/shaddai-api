import type { z } from 'zod';

/** Parsea y tipa la entrada; un ZodError lo convierte el error handler en 400 VALIDATION_ERROR. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  return schema.parse(input);
}
