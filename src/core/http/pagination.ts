import { z } from 'zod';

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type Pagination = z.infer<typeof PaginationQuery>;

export const toSkipTake = ({ page, pageSize }: Pagination) => ({
  skip: (page - 1) * pageSize,
  take: pageSize,
});

export const paged = <T>(items: T[], total: number, { page, pageSize }: Pagination) => ({
  items,
  total,
  page,
  pageSize,
});
