import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as songs from './songs.service.js';

const t = tenantRouter();
export const worshipRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

t.get('/songs', 'alabanza.ver', async (req, res) => {
  res.json(await songs.listSongs(parse(songs.ListSongsQuery, req.query)));
});

t.get('/songs/:id', 'alabanza.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await songs.getSong(id));
});

t.post('/songs', 'alabanza.canciones', async (req, res) => {
  const input = parse(songs.CreateSongSchema, req.body);
  res.status(201).json(await songs.createSong(await viewerOf(req), input));
});

t.patch('/songs/:id', 'alabanza.canciones', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await songs.updateSong(id, parse(songs.UpdateSongSchema, req.body)));
});

t.delete('/songs/:id', 'alabanza.canciones', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await songs.deleteSong(id);
  res.status(204).end();
});
