import type { PermissionKey, PermissionScope } from './catalog.js';
import { ADMIN_ROLE_KEY } from './resolve.js';

type Grants = Partial<Record<PermissionKey, PermissionScope>>;
type Locale = 'es' | 'en' | 'pt';

export interface DefaultRole {
  systemKey: string;
  names: Record<Locale, string>;
  description: Record<Locale, string>;
  isLocked?: boolean;
  grants: Grants;
}

const T = 'all' as const;
const P = 'own' as const;

const all = (keys: PermissionKey[], scope: PermissionScope = T): Grants =>
  Object.fromEntries(keys.map((k) => [k, scope]));

/**
 * Roles que recibe cada cuenta nueva (matriz del plan). La cuenta puede editarlos o crear otros;
 * el Administrador está bloqueado y tiene siempre todos los permisos (ver resolvePermissions).
 * Un permiso sin soporte de alcance "own" se guarda como "all" (ver normalizeGrants).
 */
export const DEFAULT_ROLES: DefaultRole[] = [
  {
    systemKey: ADMIN_ROLE_KEY,
    names: { es: 'Administrador', en: 'Administrator', pt: 'Administrador' },
    description: {
      es: 'Acceso total a la cuenta. No se puede editar ni borrar.',
      en: 'Full access to the account. Cannot be edited or deleted.',
      pt: 'Acesso total à conta. Não pode ser editado nem excluído.',
    },
    isLocked: true,
    grants: {},
  },
  {
    systemKey: 'pastor',
    names: { es: 'Pastor', en: 'Pastor', pt: 'Pastor' },
    description: {
      es: 'Visión completa de la iglesia, sin administrar usuarios ni cierres contables.',
      en: 'Full view of the church, without managing users or accounting closes.',
      pt: 'Visão completa da igreja, sem administrar usuários nem fechamentos contábeis.',
    },
    grants: all([
      'dashboard.ver',
      'personas.ver',
      'personas.crear',
      'personas.editar',
      'personas.eliminar',
      'personas.ver_sensibles',
      'personas.fusionar',
      'personas.importar',
      'personas.exportar',
      'personas.nuevos_revisar',
      'consolidacion.ver',
      'consolidacion.gestionar',
      'consolidacion.asignar',
      'celulas.ver',
      'celulas.crear',
      'celulas.editar',
      'celulas.eliminar',
      'celulas.reportar',
      'celulas.ver_direccion',
      'celulas.multiplicar',
      'celulas.ver_reportes',
      'estructura.gestionar',
      'catalogos.gestionar',
      'ministerios.ver',
      'ministerios.gestionar',
      'ministerios.turnos',
      'alabanza.ver',
      'alabanza.canciones',
      'alabanza.listas',
      'eventos.ver',
      'eventos.gestionar',
      'eventos.inscripciones',
      'asistencia.ver',
      'asistencia.registrar',
      'finanzas.ver',
      'finanzas.registrar',
      'finanzas.reportes',
      'finanzas.arqueo',
      'finanzas.confirmar_pendientes',
      'finanzas.diezmos_nominales',
      'inventario.ver',
      'usuarios.ver',
      'roles.ver',
    ]),
  },
  {
    systemKey: 'treasurer',
    names: { es: 'Tesorero', en: 'Treasurer', pt: 'Tesoureiro' },
    description: {
      es: 'Finanzas completas: movimientos, arqueos, cierres y reportes.',
      en: 'Full finances: transactions, counts, closes and reports.',
      pt: 'Finanças completas: movimentos, contagens, fechamentos e relatórios.',
    },
    grants: all([
      'dashboard.ver',
      'personas.ver',
      'eventos.ver',
      'asistencia.ver',
      'finanzas.ver',
      'finanzas.registrar',
      'finanzas.anular',
      'finanzas.diezmos_nominales',
      'finanzas.arqueo',
      'finanzas.confirmar_pendientes',
      'finanzas.cierre',
      'finanzas.cajas',
      'finanzas.categorias',
      'finanzas.reportes',
    ]),
  },
  {
    systemKey: 'secretary',
    names: { es: 'Secretaría', en: 'Secretary', pt: 'Secretaria' },
    description: {
      es: 'Personas, estructura, eventos y asistencia.',
      en: 'People, structure, events and attendance.',
      pt: 'Pessoas, estrutura, eventos e presença.',
    },
    grants: all([
      'dashboard.ver',
      'personas.ver',
      'personas.crear',
      'personas.editar',
      'personas.eliminar',
      'personas.fusionar',
      'personas.importar',
      'personas.exportar',
      'personas.nuevos_revisar',
      'consolidacion.ver',
      'consolidacion.gestionar',
      'consolidacion.asignar',
      'celulas.ver',
      'celulas.ver_reportes',
      'celulas.ver_direccion',
      'estructura.gestionar',
      'catalogos.gestionar',
      'ministerios.ver',
      'eventos.ver',
      'eventos.gestionar',
      'eventos.inscripciones',
      'asistencia.ver',
      'asistencia.registrar',
      'inventario.ver',
      'usuarios.ver',
    ]),
  },
  {
    systemKey: 'supervisor',
    names: { es: 'Supervisor de red/zona', en: 'Network/zone supervisor', pt: 'Supervisor de rede/zona' },
    description: {
      es: 'Supervisa las células de sus redes y zonas.',
      en: 'Oversees the cells of their networks and zones.',
      pt: 'Supervisiona as células de suas redes e zonas.',
    },
    grants: {
      ...all(
        [
          'dashboard.ver',
          'personas.ver',
          'personas.crear',
          'personas.editar',
          'consolidacion.ver',
          'consolidacion.gestionar',
          'consolidacion.asignar',
          'celulas.ver',
          'celulas.crear',
          'celulas.editar',
          'celulas.reportar',
          'celulas.ver_direccion',
          'celulas.multiplicar',
          'celulas.ver_reportes',
        ],
        P,
      ),
      ...all(['eventos.ver', 'asistencia.ver']),
    },
  },
  {
    systemKey: 'cell_leader',
    names: { es: 'Líder de célula', en: 'Cell leader', pt: 'Líder de célula' },
    description: {
      es: 'Gestiona su célula: integrantes, reportes semanales y seguimiento.',
      en: 'Manages their cell: members, weekly reports and follow-up.',
      pt: 'Gerencia sua célula: membros, relatórios semanais e acompanhamento.',
    },
    grants: {
      ...all(
        [
          'dashboard.ver',
          'personas.ver',
          'personas.crear',
          'personas.editar',
          'consolidacion.ver',
          'consolidacion.gestionar',
          'celulas.ver',
          'celulas.editar',
          'celulas.reportar',
          'celulas.ver_direccion',
          'celulas.ver_reportes',
        ],
        P,
      ),
      ...all(['eventos.ver']),
    },
  },
  {
    systemKey: 'consolidator',
    names: { es: 'Consolidador', en: 'Follow-up worker', pt: 'Consolidador' },
    description: {
      es: 'Acompaña a los nuevos que tiene asignados.',
      en: 'Follows up with the newcomers assigned to them.',
      pt: 'Acompanha os novos que lhe foram atribuídos.',
    },
    grants: {
      ...all(
        [
          'dashboard.ver',
          'personas.ver',
          'personas.crear',
          'personas.editar',
          'consolidacion.ver',
          'consolidacion.gestionar',
          'celulas.ver_direccion',
        ],
        P,
      ),
      ...all(['personas.nuevos_revisar', 'eventos.ver']),
    },
  },
  {
    systemKey: 'ministry_leader',
    names: { es: 'Líder de ministerio', en: 'Ministry leader', pt: 'Líder de ministério' },
    description: {
      es: 'Gestiona los ministerios que lidera y sus turnos.',
      en: 'Manages the ministries they lead and their schedules.',
      pt: 'Gerencia os ministérios que lidera e suas escalas.',
    },
    grants: {
      ...all(['dashboard.ver', 'ministerios.ver', 'ministerios.gestionar', 'ministerios.turnos'], P),
      ...all(['eventos.ver']),
    },
  },
  {
    systemKey: 'worship',
    names: { es: 'Alabanza', en: 'Worship', pt: 'Louvor' },
    description: {
      es: 'Repertorio, listas por culto y músicos.',
      en: 'Song library, service setlists and musicians.',
      pt: 'Repertório, listas por culto e músicos.',
    },
    grants: {
      ...all(['dashboard.ver', 'ministerios.ver', 'ministerios.gestionar', 'ministerios.turnos'], P),
      ...all(['alabanza.ver', 'alabanza.canciones', 'alabanza.listas', 'eventos.ver', 'inventario.ver']),
    },
  },
  {
    systemKey: 'tech',
    names: { es: 'Técnica', en: 'Tech team', pt: 'Técnica' },
    description: {
      es: 'Sonido y multimedia: inventario, préstamos y turnos.',
      en: 'Sound and media: inventory, loans and schedules.',
      pt: 'Som e multimídia: inventário, empréstimos e escalas.',
    },
    grants: {
      ...all(['dashboard.ver', 'ministerios.ver', 'ministerios.gestionar', 'ministerios.turnos'], P),
      ...all([
        'alabanza.ver',
        'eventos.ver',
        'inventario.ver',
        'inventario.gestionar',
        'inventario.prestamos',
      ]),
    },
  },
  {
    systemKey: 'member',
    names: { es: 'Miembro', en: 'Member', pt: 'Membro' },
    description: {
      es: 'Acceso básico: calendario y sus propios servicios.',
      en: 'Basic access: calendar and their own assignments.',
      pt: 'Acesso básico: calendário e suas próprias escalas.',
    },
    grants: { ...all(['dashboard.ver'], P), ...all(['eventos.ver']) },
  },
];
