import { PageHead } from './ui/PageHead';
import { ButtonLink } from './ui/Button';

/** 404 copy, rendered inside the shell by both not-found routes. */
export function NotFoundBody() {
  return (
    <>
      <PageHead
        title="This bird flew off"
        description="There is nothing at this address. It may have moved, or the link is wrong."
      />
      <div>
        <ButtonLink href="/" variant="secondary">
          Back to Magpipe
        </ButtonLink>
      </div>
    </>
  );
}
