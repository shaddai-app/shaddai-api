/**
 * Catálogo global de permisos `modulo.accion`. Fuente de verdad para seed, API y (vía OpenAPI) el front.
 * `scope: true` = el permiso admite alcance "own" (solo lo propio) además de "all".
 */
const definitions = {
  dashboard: { ver: true },
  personas: {
    ver: true,
    crear: false,
    editar: true,
    eliminar: false,
    ver_sensibles: true,
    fusionar: false,
    importar: false,
    exportar: false,
    nuevos_revisar: false,
  },
  consolidacion: { ver: true, gestionar: true, asignar: true },
  celulas: {
    ver: true,
    crear: true,
    editar: true,
    eliminar: false,
    reportar: true,
    ver_direccion: true,
    multiplicar: true,
    ver_reportes: true,
  },
  estructura: { gestionar: false },
  catalogos: { gestionar: false },
  ministerios: { ver: true, gestionar: true, turnos: true },
  alabanza: { ver: false, canciones: false, listas: false },
  eventos: { ver: false, gestionar: false, inscripciones: false },
  asistencia: { ver: false, registrar: false },
  finanzas: {
    ver: false,
    registrar: false,
    anular: false,
    diezmos_nominales: false,
    arqueo: false,
    confirmar_pendientes: false,
    cierre: false,
    reabrir_cierre: false,
    cajas: false,
    categorias: false,
    reportes: false,
  },
  inventario: { ver: false, gestionar: false, prestamos: false },
  anuncios: { gestionar: false },
  oracion: { pastoral: false },
  usuarios: { ver: false, gestionar: false, resetear: false },
  roles: { ver: false, gestionar: false },
  cuenta: { configurar: false },
  auditoria: { ver: false },
} as const;

type Defs = typeof definitions;
export type PermissionKey = {
  [M in keyof Defs]: `${M & string}.${keyof Defs[M] & string}`;
}[keyof Defs];

export type PermissionScope = 'all' | 'own';

export interface PermissionDefinition {
  key: PermissionKey;
  module: string;
  action: string;
  supportsScope: boolean;
  sortOrder: number;
}

export const PERMISSIONS: readonly PermissionDefinition[] = Object.entries(definitions)
  .flatMap(([module, actions]) =>
    Object.entries(actions).map(([action, supportsScope]) => ({
      key: `${module}.${action}` as PermissionKey,
      module,
      action,
      supportsScope,
      sortOrder: 0,
    })),
  )
  .map((p, i) => ({ ...p, sortOrder: (i + 1) * 10 }));

export const PERMISSION_KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));
