import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { env } from '../../config/env.js';

/** Dónde viven los binarios. En producción se implementa con R2/S3 sin tocar a los llamadores. */
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

export const storage: StorageProvider = new LocalStorage();
