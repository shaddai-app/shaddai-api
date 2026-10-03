import { logger } from '../logger.js';
import { storage } from '../storage/storage.js';
import { prisma } from './prisma.js';
import { tenantClientFor } from './tenant.js';

/**
 * Todos los datos de una iglesia, en orden de borrado (hijos antes que padres). Lo usan la exportación
 * (`export: false` = no sale: credenciales, sesiones o datos internos) y la purga de una cuenta dada de
 * baja. Un modelo nuevo de cuenta DEBE agregarse acá: lo verifica test/unit/account-data.test.ts.
 */
export const ACCOUNT_DATA: readonly { model: string; export: boolean }[] = [
  { model: 'Notification', export: false },
  { model: 'DailyJobRun', export: false },
  { model: 'EventRegistration', export: true },
  { model: 'MovementAttachment', export: true },
  { model: 'FinanceMovement', export: true },
  { model: 'OfferingCountLine', export: true },
  { model: 'OfferingCount', export: true },
  { model: 'ServiceAttendance', export: true },
  { model: 'InventoryLoan', export: true },
  { model: 'InventoryMaintenance', export: true },
  { model: 'InventoryItem', export: true },
  { model: 'SetlistItem', export: true },
  { model: 'Setlist', export: true },
  { model: 'SongLink', export: true },
  { model: 'Song', export: true },
  { model: 'ServiceAssignment', export: true },
  { model: 'Unavailability', export: true },
  { model: 'ServiceRole', export: true },
  { model: 'MinistryMember', export: true },
  { model: 'Ministry', export: true },
  { model: 'EventException', export: true },
  { model: 'CalendarEvent', export: true },
  { model: 'FinancePeriodBalance', export: true },
  { model: 'FinancePeriod', export: true },
  { model: 'FinanceCategory', export: true },
  { model: 'FinanceAccount', export: true },
  { model: 'FollowUp', export: true },
  { model: 'ConsolidationCaseStep', export: true },
  { model: 'ConsolidationCase', export: true },
  { model: 'ConsolidationStep', export: true },
  { model: 'RefreshToken', export: false },
  { model: 'PasswordResetToken', export: false },
  { model: 'UserRole', export: true },
  { model: 'RolePermission', export: true },
  { model: 'Role', export: true },
  { model: 'User', export: true },
  { model: 'CellReportAttendance', export: true },
  { model: 'CellReport', export: true },
  { model: 'CellMultiplication', export: true },
  { model: 'CellMember', export: true },
  { model: 'Cell', export: true },
  { model: 'Zone', export: true },
  { model: 'Network', export: true },
  { model: 'NewcomerSubmission', export: true },
  { model: 'ImportJob', export: true },
  { model: 'PersonTag', export: true },
  { model: 'PersonMilestone', export: true },
  { model: 'PersonPosition', export: true },
  { model: 'PersonStatusHistory', export: true },
  { model: 'Person', export: true },
  { model: 'Household', export: true },
  { model: 'Tag', export: true },
  { model: 'CatalogItem', export: true },
  { model: 'FileObject', export: true },
  { model: 'Campus', export: true },
];

/** Columnas que nunca salen en la exportación (credenciales y estado de seguridad). */
const OMIT: Record<string, string[]> = {
  User: ['passwordHash', 'totpSecretEnc', 'failedLoginCount', 'lockoutLevel', 'lockedUntil'],
};

type Delegate = {
  findMany: (args?: object) => Promise<Record<string, unknown>[]>;
  deleteMany: (args?: object) => Promise<{ count: number }>;
  updateMany: (args: object) => Promise<{ count: number }>;
};
const delegateOf = (client: object, model: string) =>
  (client as Record<string, Delegate>)[model.charAt(0).toLowerCase() + model.slice(1)]!;

/** Nombre del archivo de la exportación para un modelo: FinanceMovement → finance-movement.json. */
export const exportFileName = (model: string) =>
  model.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + '.json';

/** Filas de un modelo, ya sin las columnas reservadas. */
export async function exportRows(accountId: number, model: string): Promise<Record<string, unknown>[]> {
  const rows = await delegateOf(tenantClientFor(accountId), model).findMany({});
  const omit = OMIT[model] ?? [];
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !omit.includes(key))));
}

/** La cuenta en sí y su auditoría (no son modelos tenant). */
export async function exportAccountRecord(accountId: number) {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const audit = await prisma.auditLog.findMany({ where: { accountId }, orderBy: { id: 'asc' } });
  return { account, audit };
}

/**
 * Borra definitivamente una iglesia: binarios, todas sus filas, su auditoría y la cuenta. Es
 * idempotente: si se corta a mitad de camino, la próxima pasada sigue desde donde quedó.
 */
export async function purgeAccount(accountId: number): Promise<{ files: number; rows: number }> {
  const db = tenantClientFor(accountId);
  const files = await db.fileObject.findMany({ select: { storageKey: true } });
  for (const file of files) await storage.delete(file.storageKey);
  // El logo de la cuenta apunta a un archivo que se borra antes que la cuenta.
  await prisma.account.updateMany({ where: { id: accountId }, data: { logoFileId: null } });

  // Las células se apuntan entre sí (multiplicación): se cortan antes de borrarlas.
  await db.cell.updateMany({ data: { parentCellId: null } });
  let rows = 0;
  for (const { model } of ACCOUNT_DATA) rows += (await delegateOf(db, model).deleteMany({})).count;
  rows += (await prisma.auditLog.deleteMany({ where: { accountId } })).count;
  await prisma.account.deleteMany({ where: { id: accountId } });
  logger.info({ accountId, files: files.length, rows }, 'account purged');
  return { files: files.length, rows };
}

/** Cuentas cerradas cuyo plazo de conservación ya venció. Lo llama el programador de procesos. */
export async function purgeExpiredAccounts(now = new Date()): Promise<number[]> {
  const due = await prisma.account.findMany({
    where: { status: 'closed', purgeAfter: { lte: now } },
    select: { id: true, slug: true },
  });
  for (const account of due) {
    await purgeAccount(account.id);
    // Sin datos de la iglesia: solo el id y el slug, para saber que se purgó y cuándo.
    await prisma.auditLog.create({
      data: {
        action: 'platform.account.purged',
        entity: 'Account',
        entityId: String(account.id),
        after: JSON.stringify({ slug: account.slug }),
      },
    });
  }
  return due.map((a) => a.id);
}
