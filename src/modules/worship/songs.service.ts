import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { audit } from '../../core/audit/audit.js';
import { currentAccountId, tenantDb } from '../../core/db/tenant.js';
import { AppError } from '../../core/http/errors.js';
import { PaginationQuery, paged, toSkipTake } from '../../core/http/pagination.js';
import { fold } from '../people/people.service.js';
import type { Viewer } from '../people/people.scope.js';

// Repertorio de alabanza. La letra con acordes se guarda en ChordPro; el front la muestra y la
// transpone (la API no la interpreta).

export const LINK_TYPES = ['youtube', 'spotify', 'multitrack', 'sheet', 'other'] as const;
export const KEY_PATTERN = /^[A-G](#|b)?m?$/;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const Link = z
  .object({
    type: z.enum(LINK_TYPES),
    url: z.url({ protocol: /^https?$/ }).max(500),
    label: optionalText(100),
  })
  .strict();

const SongFields = z.object({
  title: z.string().trim().min(1).max(150),
  author: optionalText(150),
  ccliNumber: z
    .string()
    .trim()
    .regex(/^\d{0,15}$/)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  originalKey: z
    .string()
    .trim()
    .regex(KEY_PATTERN)
    .or(z.literal('').transform(() => null))
    .nullable()
    .optional(),
  bpm: z.number().int().min(20).max(300).nullable().optional(),
  timeSignature: z
    .string()
    .trim()
    .regex(/^\d{1,2}\/\d{1,2}$/)
    .or(z.literal('').transform(() => null))
    .nullable()
    .optional(),
  chordPro: z
    .string()
    .max(50_000)
    .transform((v) => (v.trim() === '' ? null : v.replace(/\r\n/g, '\n')))
    .nullable()
    .optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(15).optional(),
  notes: optionalText(1000),
  isActive: z.boolean().optional(),
  links: z.array(Link).max(10).optional(),
});

export const CreateSongSchema = SongFields.strict();
export const UpdateSongSchema = SongFields.partial().strict();

export const ListSongsQuery = PaginationQuery.extend({
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(40).optional(),
  includeInactive: z.stringbool().default(false),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Etiquetas normalizadas: sin comas y sin repetir (sin distinguir mayúsculas; queda la primera). */
function tagsText(tags: string[] | undefined) {
  if (tags === undefined) return undefined;
  const unique = new Map<string, string>();
  for (const t of tags.map((x) => x.replace(/,/g, ' ').trim())) {
    if (!unique.has(t.toLowerCase())) unique.set(t.toLowerCase(), t);
  }
  return [...unique.values()].join(',') || null;
}
const tagsOf = (text: string | null) => (text ? text.split(',').filter(Boolean) : []);

/** Etiqueta exacta dentro de la lista separada por comas (la collation no distingue mayúsculas). */
const tagWhere = (tag: string): Prisma.SongWhereInput => ({
  OR: [
    { tags: tag },
    { tags: { startsWith: `${tag},` } },
    { tags: { endsWith: `,${tag}` } },
    { tags: { contains: `,${tag},` } },
  ],
});

const searchTextOf = (s: { title: string; author?: string | null; ccliNumber?: string | null }) =>
  fold([s.title, s.author, s.ccliNumber].filter(Boolean).join(' ')).slice(0, 450);

const listSelect = {
  id: true,
  title: true,
  author: true,
  ccliNumber: true,
  originalKey: true,
  bpm: true,
  timeSignature: true,
  tags: true,
  isActive: true,
  updatedAt: true,
} as const;

export async function listSongs(q: z.infer<typeof ListSongsQuery>) {
  const words = fold(q.q).split(' ').filter(Boolean);
  const where: Prisma.SongWhereInput = {
    AND: [
      { deletedAt: null },
      q.includeInactive ? {} : { isActive: true },
      ...words.map((w) => ({ searchText: { contains: w } })),
      ...(q.tag ? [tagWhere(q.tag)] : []),
    ],
  };
  const db = tenantDb();
  const [rows, total, all] = await Promise.all([
    db.song.findMany({ where, select: listSelect, orderBy: { title: 'asc' }, ...toSkipTake(q) }),
    db.song.count({ where }),
    // Todas las etiquetas en uso (para el filtro).
    db.song.findMany({ where: { deletedAt: null, tags: { not: null } }, select: { tags: true } }),
  ]);
  const tags = [...new Set(all.flatMap((s) => tagsOf(s.tags)))].sort((a, b) => a.localeCompare(b));
  const items = rows.map((s) => ({ ...s, tags: tagsOf(s.tags) }));
  return { ...paged(items, total, q), tags };
}

async function findSong(id: number) {
  const song = await tenantDb().song.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...listSelect,
      chordPro: true,
      notes: true,
      createdAt: true,
      links: { select: { id: true, type: true, url: true, label: true }, orderBy: { id: 'asc' } },
    },
  });
  if (!song) throw AppError.notFound('SONG_NOT_FOUND');
  return song;
}

export async function getSong(id: number) {
  const song = await findSong(id);
  return { ...song, tags: tagsOf(song.tags) };
}

export async function createSong(viewer: Viewer, input: z.infer<typeof CreateSongSchema>) {
  const { links, tags, ...fields } = input;
  const created = await tenantDb().song.create({
    data: {
      accountId: currentAccountId(),
      ...fields,
      tags: tagsText(tags) ?? null,
      searchText: searchTextOf(fields),
      createdById: viewer.userId,
      // Escritura anidada: los enlaces son hijos de la canción.
      links: { create: (links ?? []).map((l) => ({ ...l, label: l.label ?? null })) },
    },
    select: { id: true },
  });
  await audit({
    action: 'songs.create',
    entity: 'Song',
    entityId: created.id,
    after: { title: input.title },
  });
  return getSong(created.id);
}

export async function updateSong(id: number, input: z.infer<typeof UpdateSongSchema>) {
  const before = await findSong(id);
  const { links, tags, ...fields } = input;
  const merged = {
    title: fields.title ?? before.title,
    author: fields.author,
    ccliNumber: fields.ccliNumber,
  };
  if (merged.author === undefined) merged.author = before.author;
  if (merged.ccliNumber === undefined) merged.ccliNumber = before.ccliNumber;
  await tenantDb().song.update({
    where: { id },
    data: {
      ...fields,
      ...(tags !== undefined ? { tags: tagsText(tags) } : {}),
      searchText: searchTextOf(merged),
      // Los enlaces se reemplazan enteros.
      ...(links
        ? { links: { deleteMany: {}, create: links.map((l) => ({ ...l, label: l.label ?? null })) } }
        : {}),
    },
  });
  await audit({
    action: 'songs.update',
    entity: 'Song',
    entityId: id,
    before: { title: before.title },
    after: { changed: Object.keys(input) },
  });
  return getSong(id);
}

/** Borrado lógico (más adelante, las listas de canciones conservan su historial). */
export async function deleteSong(id: number) {
  const song = await findSong(id);
  await tenantDb().song.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit({ action: 'songs.delete', entity: 'Song', entityId: id, before: { title: song.title } });
}
