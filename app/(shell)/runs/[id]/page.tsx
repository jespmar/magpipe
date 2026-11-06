import type { Metadata } from 'next';
import { PageHead } from '@/components/ui/PageHead';
import { Placeholder } from '@/components/ui/Placeholder';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: (await params).id };
}

export default async function RunDetailPage({ params }: Props) {
  const { id } = await params;
  return (
    <>
      <PageHead eyebrow="Flight" title={id} />
      <Placeholder pr={7} spec="§3.4" artboards="Runs · RunsWide">
        <p className="text-body-sm text-body">
          Flight path · streaming flight log (SSE) · output · artifacts · Re-fly / Cancel.
        </p>
      </Placeholder>
    </>
  );
}
