import { z } from 'zod';
import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import * as courses from './courses.service.js';

const t = tenantRouter();
export const coursesRouter = t.router;

const IdParam = z.object({ id: z.coerce.number().int().positive() });

// ───────────── Cursos y niveles ─────────────

t.get('/courses', 'discipulado.ver', async (req, res) => {
  res.json(await courses.listCourses(await viewerOf(req), parse(courses.ListQuery, req.query)));
});

t.get('/courses/:id', 'discipulado.ver', async (req, res) => {
  res.json(await courses.getCourse(await viewerOf(req), parse(IdParam, req.params).id));
});

t.post('/courses', 'discipulado.gestionar', async (req, res) => {
  const input = parse(courses.CreateCourseSchema, req.body);
  res.status(201).json(await courses.createCourse(await viewerOf(req), input));
});

t.patch('/courses/:id', 'discipulado.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(courses.UpdateCourseSchema, req.body);
  res.json(await courses.updateCourse(await viewerOf(req), id, input));
});

t.delete('/courses/:id', 'discipulado.gestionar', async (req, res) => {
  await courses.deleteCourse(parse(IdParam, req.params).id);
  res.status(204).end();
});

t.post('/courses/:id/levels', 'discipulado.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(courses.CreateLevelSchema, req.body);
  res.status(201).json(await courses.addLevel(await viewerOf(req), id, input));
});

t.put('/courses/:id/levels/order', 'discipulado.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const { ids } = parse(courses.ReorderSchema, req.body);
  res.json(await courses.reorderLevels(await viewerOf(req), id, ids));
});

t.patch('/course-levels/:id', 'discipulado.gestionar', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(courses.UpdateLevelSchema, req.body);
  res.json(await courses.updateLevel(await viewerOf(req), id, input));
});

t.delete('/course-levels/:id', 'discipulado.gestionar', async (req, res) => {
  await courses.deleteLevel(parse(IdParam, req.params).id);
  res.status(204).end();
});

// ───────────── Inscripciones (alcance propio: los niveles que enseña) ─────────────

t.get('/course-levels/:id/enrollments', 'discipulado.ver', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const query = parse(courses.EnrollmentQuery, req.query);
  res.json(await courses.listEnrollments(await viewerOf(req), id, query));
});

t.post('/course-levels/:id/enrollments', 'discipulado.inscribir', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(courses.EnrollSchema, req.body);
  res.status(201).json(await courses.enroll(await viewerOf(req), id, input));
});

t.patch('/course-enrollments/:id', 'discipulado.inscribir', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(courses.UpdateEnrollmentSchema, req.body);
  res.json(await courses.updateEnrollment(await viewerOf(req), id, input));
});

t.delete('/course-enrollments/:id', 'discipulado.inscribir', async (req, res) => {
  await courses.deleteEnrollment(await viewerOf(req), parse(IdParam, req.params).id);
  res.status(204).end();
});

t.get('/people/:id/courses', 'discipulado.ver', async (req, res) => {
  res.json(await courses.personCourses(await viewerOf(req), parse(IdParam, req.params).id));
});
