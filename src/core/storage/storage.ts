import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { env } from '../../config/env.js';

/** Dónde viven los binarios: carpeta local en desarrollo, bucket S3/R2 en producción. */
export interface StorageProvider {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalStorage implements StorageProvider {
  private readonly root = resolve(env.STORAGE_LOCAL_PATH);

  private pathFor(key: string): string {
    const full = resolve(this.root, key);
    // Las claves las genera el servidor, pero igual se impide salir de la carpeta raíz.
    if (!full.startsWith(this.root + sep)) throw new Error('Clave de almacenamiento inválida');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

/** Bucket compatible con S3 (Cloudflare R2). Privado: los archivos se sirven siempre a través de la API. */
export class S3Storage implements StorageProvider {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    private readonly bucket: string,
  ) {}

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    } catch (err) {
      // Igual que el disco local: un archivo que no está es ENOENT.
      if (err instanceof Error && err.name === 'NoSuchKey') {
        throw Object.assign(new Error(`Archivo inexistente: ${key}`), { code: 'ENOENT' });
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function createStorage(): StorageProvider {
  if (env.STORAGE_DRIVER === 'local') return new LocalStorage();
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
  });
  return new S3Storage(client, env.S3_BUCKET!);
}

export const storage: StorageProvider = createStorage();
