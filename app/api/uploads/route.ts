import { NextResponse } from 'next/server';
import { apiError, requireUser } from '@/lib/api';
import { saveUpload, UploadError } from '@/lib/uploads';

export const dynamic = 'force-dynamic';

/** POST /api/uploads — multipart `file` field(s) → the records a run can attach (spec §8). */
export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError('invalid_form', 'Send the files as multipart form data.');
  }
  const files = form.getAll('file').filter((f): f is File => f instanceof File);
  if (files.length === 0) return apiError('validation', 'No file in the request.');
  try {
    const uploads = [];
    for (const file of files) uploads.push(await saveUpload(file));
    return NextResponse.json({ uploads }, { status: 201 });
  } catch (err) {
    if (err instanceof UploadError) return apiError(err.code, err.message);
    console.error('[uploads]', err);
    return apiError('upload_failed', 'The file could not be stored.', 500);
  }
}
