import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { currentAccountId, tenantDb } from '../db/tenant.js';
import { AppError } from '../http/errors.js';
import { getContext } from '../context.js';
import { storage } from '../storage/storage.js';

export type FilePurpose = 'logo' | 'receipt' | 'photo' | 'cell_report' | 'inventory';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Normaliza una imagen subida: valida el tipo REAL (magic bytes, no la extensión ni el header del
 * navegador), descarta metadatos (EXIF/GPS) y la reduce a webp. SVG no se acepta (puede llevar scripts).
 */
export async function processImage(input: Buffer, maxSize: number): Promise<Buffer> {
  const detected = await fileTypeFromBuffer(input);
  if (!detected || !IMAGE_TYPES.has(detected.mime)) throw AppError.badRequest('FILE_TYPE_NOT_ALLOWED');
  return sharp(input, { limitInputPixels: 40_000_000 })
    .rotate() // respeta la orientación EXIF antes de descartarla
    .resize({ width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();
}

/** Guarda un archivo de la cuenta actual respetando la cuota de almacenamiento del plan. */
export async function saveFile(input: {
  data: Buffer;
  originalName: string;
  mimeType: string;
  purpose: FilePurpose;
}) {
  const accountId = currentAccountId();
  const db = tenantDb();
  const account = await db.account.findUniqueOrThrow({
    where: { id: accountId },
    select: { storageUsedBytes: true, storageLimitMb: true },
  });
  const limit = BigInt(account.storageLimitMb) * 1_048_576n;
  if (account.storageUsedBytes + BigInt(input.data.length) > limit) {
    throw AppError.conflict('STORAGE_LIMIT_REACHED');
  }

  const key = `${accountId}/${input.purpose}/${randomUUID()}`;
  await storage.put(key, input.data, input.mimeType);
  try {
    return await db.$transaction(async (tx) => {
      const file = await tx.fileObject.create({
        data: {
          accountId,
          storageKey: key,
          originalName: input.originalName.slice(0, 250),
          mimeType: input.mimeType,
          sizeBytes: input.data.length,
          purpose: input.purpose,
          uploadedById: getContext()!.userId!,
        },
      });
      await tx.account.update({
        where: { id: accountId },
        data: { storageUsedBytes: { increment: input.data.length } },
      });
      return file;
    });
  } catch (err) {
    await storage.delete(key); // sin registro en la DB, el binario no debe quedar huérfano
    throw err;
  }
}

/** Baja lógica + libera la cuota. El binario se borra al instante (no hay papelera de archivos). */
export async function deleteFile(fileId: number): Promise<void> {
  const db = tenantDb();
  const file = await db.fileObject.findUnique({ where: { id: fileId } });
  if (!file || file.deletedAt) return;
  await db.$transaction([
    db.fileObject.update({ where: { id: fileId }, data: { deletedAt: new Date() } }),
    db.account.update({
      where: { id: currentAccountId() },
      data: { storageUsedBytes: { decrement: file.sizeBytes } },
    }),
  ]);
  await storage.delete(file.storageKey);
}

export async function readFileObject(fileId: number) {
  const file = await tenantDb().fileObject.findUnique({ where: { id: fileId } });
  if (!file || file.deletedAt) throw AppError.notFound('FILE_NOT_FOUND');
  return { file, data: await storage.get(file.storageKey) };
}
