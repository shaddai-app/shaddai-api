import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as setlists from './setlists.service.js';
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

t.get('/songs/:id/usage', 'alabanza.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await setlists.songUsage(await viewerOf(req), id));
});

// ───────────── Listas de canciones ─────────────

t.get('/setlists', 'alabanza.ver', async (req, res) => {
  res.json(await setlists.listSetlists(await viewerOf(req), parse(setlists.ListSetlistsQuery, req.query)));
});

t.get('/setlists/:id', 'alabanza.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await setlists.getSetlist(await viewerOf(req), id));
});

t.post('/setlists', 'alabanza.listas', async (req, res) => {
  const input = parse(setlists.CreateSetlistSchema, req.body);
  res.status(201).json(await setlists.createSetlist(await viewerOf(req), input));
});

t.patch('/setlists/:id', 'alabanza.listas', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(
    await setlists.updateSetlist(await viewerOf(req), id, parse(setlists.UpdateSetlistSchema, req.body)),
  );
});

t.put('/setlists/:id/items', 'alabanza.listas', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await setlists.setItems(await viewerOf(req), id, parse(setlists.ItemsSchema, req.body)));
});

t.delete('/setlists/:id', 'alabanza.listas', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  await setlists.deleteSetlist(await viewerOf(req), id);
  res.status(204).end();
});
