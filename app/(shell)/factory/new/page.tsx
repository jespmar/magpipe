import type { Metadata } from 'next';
import { ProjectEditorPage } from '../project-editor';

export const metadata: Metadata = { title: 'New project' };
export const dynamic = 'force-dynamic';

/** A new factory project (D46): its folder, Linear project and GitHub repository. */
export default async function NewProjectPage() {
  const page = await ProjectEditorPage({ id: null });
  return page === 'missing' ? null : page;
}
