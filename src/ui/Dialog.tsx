import { type ReactNode, type Ref, useId } from 'react';
import { S } from './strings.ts';

export function Dialog({ heading, testId, ref, children }: { heading: string; testId: string; ref: Ref<HTMLDialogElement>; children: ReactNode }) {
  const headingId = useId();
  return (
    <dialog ref={ref} className="card" aria-labelledby={headingId} data-testid={testId}>
      <div className="card-head">
        <h2 id={headingId}>{heading}</h2>
        <form method="dialog" className="spacer">
          <button type="submit" className="btn">
            {S.dialog.close}
          </button>
        </form>
      </div>
      <div className="card-body doc">{children}</div>
    </dialog>
  );
}
