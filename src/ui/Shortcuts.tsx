import type { Ref } from 'react';
import { Dialog } from './Dialog.tsx';
import { S } from './strings.ts';

export type Command = 'toggle' | 'previous' | 'next' | 'reset' | 'end' | 'slower' | 'faster' | 'shortcuts';

export const SHORTCUTS = new Map<string, Command>([
  [' ', 'toggle'],
  ['ArrowLeft', 'previous'],
  ['ArrowRight', 'next'],
  ['Home', 'reset'],
  ['End', 'end'],
  ['-', 'slower'],
  ['+', 'faster'],
  ['?', 'shortcuts'],
]);

export function ShortcutsDialog({ ref }: { ref: Ref<HTMLDialogElement> }) {
  return (
    <Dialog ref={ref} heading={S.shortcuts.heading} testId="shortcuts-dialog">
      <table className="shortcuts">
        <tbody>
          {[...SHORTCUTS].map(([key, command]) => (
            <tr key={key}>
              <td>
                <kbd>{S.shortcuts.keyName(key)}</kbd>
              </td>
              <td>{S.shortcuts.commands[command]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{S.shortcuts.note}</p>
    </Dialog>
  );
}
