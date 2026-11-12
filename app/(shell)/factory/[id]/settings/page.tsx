import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProjectEditorPage } from '../../project-editor';

export const metadata: Metadata = { title: 'Project settings' };
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

/** A project's settings (D46). No loading boundary of its own: an unknown id is a 404. */
export default async function ProjectSettingsPage({ params }: Props) {
  const page = await ProjectEditorPage({ id: (await params).id });
  if (page === 'missing') notFound();
  return page;
}
