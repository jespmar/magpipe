import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from './db';
import { newId } from './ids';
import { upload as uploadSchema, type Attachment, type Upload } from './schemas';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export class UploadError extends Error {
  readonly code = 'upload_invalid';
}

function uploadsDir(): string {
  return path.join(dataDir(), 'uploads');
}

/** Keeps the name readable but harmless: no separators, no leading dots, bounded length. */
export function safeFileName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '');
  return (base || 'file').slice(0, 120);
}

/** Stores the bytes under the data dir with a JSON sidecar; Vercel Blob's stand-in on desktop (D3). */
export async function saveUpload(file: File): Promise<Upload> {
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadError(`${file.name} is larger than 25 MB.`);
  const id = newId('upl');
  const name = safeFileName(file.name);
  const dir = path.join(uploadsDir(), id);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await fs.writeFile(target, Buffer.from(await file.arrayBuffer()));
  const record: Upload = {
    id,
    name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    url: target,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(`${dir}.json`, JSON.stringify(record));
  return record;
}

export async function readUpload(id: string): Promise<Upload | null> {
  try {
    const raw = await fs.readFile(path.join(uploadsDir(), `${id}.json`), 'utf8');
    return uploadSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function attachmentsFor(ids: string[]): Promise<Attachment[]> {
  if (ids.length > MAX_ATTACHMENTS)
    throw new UploadError(`A run takes at most ${MAX_ATTACHMENTS} files.`);
  const out: Attachment[] = [];
  for (const id of ids) {
    const u = await readUpload(id);
    if (!u) throw new UploadError(`Unknown upload: ${id}`);
    out.push({ blobUrl: u.url, name: u.name, size: u.size, mime: u.mime });
  }
  return out;
}
