/**
 * A modal's backdrop, rendered into <body>. The arena HUD has a
 * backdrop-filter, which makes it the containing block of any fixed element
 * inside it: a backdrop left in the HUD covers only the HUD, and the modal is
 * squeezed into it, under the leaderboard and the help card on a phone.
 */

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ModalBackdrop({ onClose, children }: { onClose(): void; children: ReactNode }): JSX.Element {
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      {children}
    </div>,
    document.body,
  );
}
