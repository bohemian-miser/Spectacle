/**
 * The feedback button and its modal: a message, an optional way to reach the
 * player, and (unless they untick it) where they were in the game. The server
 * keeps it for the triage workflow, which runs every few minutes and files it
 * as a GitHub issue that anyone's coding agent can pick up. Lives beside the
 * settings button in the lobby header and the arena HUD.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ONLINE_URL, SOLO_ONLY } from './App';
import { BACKLOG_URL, feedbackContext, feedbackUrl, issueSearchUrl, ISSUES_URL, MAX_MESSAGE, sendFeedback, type GameContext } from './feedback';

type Sending = { t: 'idle' } | { t: 'sending' } | { t: 'sent'; id: string } | { t: 'failed'; error: string };

/** `icon`: a bare speech bubble for the arena HUD's icon row; otherwise a labelled button (the lobby). */
export function FeedbackButton({ game, icon = false }: { game: () => GameContext; icon?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [details, setDetails] = useState(true);
  const [sending, setSending] = useState<Sending>({ t: 'idle' });
  const url = feedbackUrl(SOLO_ONLY, ONLINE_URL);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const show = (): void => {
    // A sent report is done with: the next one starts blank.
    if (sending.t === 'sent') {
      setMessage('');
      setSending({ t: 'idle' });
    }
    setOpen(true);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!url || !message.trim() || sending.t === 'sending') return;
    setSending({ t: 'sending' });
    const r = await sendFeedback(url, { message, contact, context: details ? feedbackContext(game()) : undefined });
    setSending(r.ok ? { t: 'sent', id: r.id } : { t: 'failed', error: r.error });
  };

  return (
    <>
      {icon ? (
        <button type="button" className="hud-icon" aria-label="Feedback" title="Feedback: report a bug or suggest something" onClick={show}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6A1.5 1.5 0 0 1 13 11.5H7.5L4.5 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : (
        <button type="button" className="btn" aria-label="Feedback" title="Report a bug or suggest something" onClick={show}>
          Feedback
        </button>
      )}
      {/* Portalled to <body>, as Settings' and Bots': the HUD's backdrop-filter traps a fixed child inside the panel. */}
      {open &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setOpen(false)}>
            <form
              className="modal feedback-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Feedback"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => void submit(e)}
            >
              <div className="modal-head">
                <b>Feedback</b>
                <button type="button" className="btn modal-close" aria-label="Close" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </div>
              {sending.t === 'sent' ? (
                <>
                  <p>
                    Thanks, it's in.{' '}
                    {sending.id && (
                      <>
                        Its id is{' '}
                        <a href={issueSearchUrl(sending.id)} target="_blank" rel="noreferrer">
                          <code>{sending.id}</code>
                        </a>
                        .
                      </>
                    )}
                  </p>
                  <p>
                    <b>Got a coding agent?</b> Check back in 10 minutes and get your coding agent to work on the bug and make a PR.
                  </p>
                </>
              ) : !url ? (
                <p className="muted">
                  This copy of the game has no server to send feedback to.{' '}
                  <a href={ISSUES_URL} target="_blank" rel="noreferrer">
                    Open an issue on GitHub
                  </a>{' '}
                  instead.
                </p>
              ) : (
                <>
                  <p>
                    Found a bug, or have an idea? Say what happened and what you expected. An agent will prepare a bug on your behalf and add it to
                    our{' '}
                    <a href={BACKLOG_URL} target="_blank" rel="noreferrer">
                      issue backlog
                    </a>
                    .
                  </p>
                  <p className="muted feedback-note">Your message may be quoted in that public issue; your contact never is.</p>
                  <textarea
                    aria-label="Message"
                    placeholder="What happened?"
                    value={message}
                    maxLength={MAX_MESSAGE}
                    autoFocus
                    onChange={(e) => setMessage(e.target.value)}
                  />
                  <input
                    type="text"
                    aria-label="Contact"
                    placeholder="Email or handle, for a reply (optional)"
                    value={contact}
                    maxLength={200}
                    onChange={(e) => setContact(e.target.value)}
                  />
                  <label className="setting setting-check">
                    <input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} />
                    <span>Include where I was (rule, room, browser)</span>
                  </label>
                  {sending.t === 'failed' && <p className="feedback-error">{sending.error}</p>}
                  <div className="feedback-actions">
                    <a href={ISSUES_URL} target="_blank" rel="noreferrer">
                      Or open a GitHub issue
                    </a>
                    <button type="submit" className="btn btn-accent" disabled={!message.trim() || sending.t === 'sending'}>
                      {sending.t === 'sending' ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                </>
              )}
            </form>
          </div>,
          document.body,
        )}
    </>
  );
}
