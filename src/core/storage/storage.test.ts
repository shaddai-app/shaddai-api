import type { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3Storage } from './storage.js';

/** Bucket falso en memoria que responde a los comandos del cliente S3. */
function fakeBucket() {
  const objects = new Map<string, { body: Buffer; type?: string }>();
  const sent: { name: string; bucket?: string }[] = [];
  const client = {
    send: async (cmd: PutObjectCommand | GetObjectCommand | DeleteObjectCommand) => {
      sent.push({ name: cmd.constructor.name, bucket: cmd.input.Bucket });
      const key = cmd.input.Key!;
      if (cmd instanceof PutObjectCommand) {
        objects.set(key, { body: cmd.input.Body as Buffer, type: cmd.input.ContentType });
        return {};
      }
      if (cmd instanceof GetObjectCommand) {
        const obj = objects.get(key);
        if (!obj) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(obj.body) } };
      }
      objects.delete(key);
      return {};
    },
  };
  return { client: client as unknown as ConstructorParameters<typeof S3Storage>[0], objects, sent };
}

describe('S3Storage', () => {
  it('guarda, lee y borra en el bucket configurado', async () => {
    const bucket = fakeBucket();
    const storage = new S3Storage(bucket.client, 'shaddai-files');

    await storage.put('1/logo/abc', Buffer.from('hola'), 'image/png');
    expect(bucket.objects.get('1/logo/abc')?.type).toBe('image/png');
    expect((await storage.get('1/logo/abc')).toString()).toBe('hola');

    await storage.delete('1/logo/abc');
    expect(bucket.objects.size).toBe(0);
    expect(bucket.sent.every((s) => s.bucket === 'shaddai-files')).toBe(true);
  });

  it('un archivo que no está es ENOENT, como en disco', async () => {
    const storage = new S3Storage(fakeBucket().client, 'b');
    await expect(storage.get('1/logo/nada')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
