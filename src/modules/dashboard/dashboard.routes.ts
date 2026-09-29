import { tenantRouter } from '../../core/http/secure-router.js';
import { parse } from '../../core/http/validate.js';
import { viewerOf } from '../people/people.scope.js';
import { dashboard, DashboardQuery } from './dashboard.service.js';

const t = tenantRouter();
export const dashboardRouter = t.router;

/** Tablero de inicio: los bloques dependen de los permisos y el alcance de cada usuario. */
t.get('/dashboard', 'dashboard.ver', async (req, res) => {
  res.json(await dashboard(await viewerOf(req), parse(DashboardQuery, req.query)));
});
