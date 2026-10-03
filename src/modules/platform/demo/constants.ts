/**
 * La iglesia demo: siempre la cuenta 1, compartida por los clientes que prueban Shaddai. Se crea en
 * el seed (antes que cualquier iglesia real) y se restablece desde el panel de plataforma.
 */
export const DEMO_ACCOUNT_ID = 1;
export const DEMO_SLUG = 'iglesia-demo';

/** Configuración original de la cuenta: el restablecimiento la vuelve a dejar así. */
export const DEMO_ACCOUNT_DEFAULTS = {
  name: 'Iglesia Demo',
  planCode: 'standard',
  defaultLocale: 'es',
  timezone: 'America/Argentina/Buenos_Aires',
  currency: 'ARS',
} as const;

/** Usuarios de la demo. Todos comparten SEED_DEMO_PASSWORD. */
export const DEMO_USERS = [
  { email: 'demo-admin@shaddai.local', firstName: 'Admin', lastName: 'Demo', role: 'admin', owner: true },
  { email: 'demo-pastor@shaddai.local', firstName: 'Pastor', lastName: 'Demo', role: 'pastor', owner: false },
  {
    email: 'demo-tesorero@shaddai.local',
    firstName: 'Tesorero',
    lastName: 'Demo',
    role: 'treasurer',
    owner: false,
  },
  {
    email: 'demo-lider@shaddai.local',
    firstName: 'Líder',
    lastName: 'Demo',
    role: 'cell_leader',
    owner: false,
  },
] as const;

/** Mail del admin de la demo: es la credencial que pide el restablecimiento. */
export const DEMO_ADMIN_EMAIL = DEMO_USERS[0].email;

/**
 * Usuarios de prueba de desarrollo (los usa Claude en el navegador). Fuera de producción sobreviven al
 * restablecimiento con su contraseña; se les vuelve a dar su rol por defecto.
 */
export const QA_USERS: Record<string, string> = {
  'qa-admin@shaddai.local': 'admin',
  'qa-tesorero@shaddai.local': 'treasurer',
  'qa-lider@shaddai.local': 'cell_leader',
  'qa-miembro@shaddai.local': 'member',
};
