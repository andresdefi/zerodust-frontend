import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ShieldIcon } from './icons';
import { OFFLINE } from '../lib/env';

const KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

export type ClipboardState = 'cleared' | 'failed' | null;

/**
 * Private key entry that never puts the key in the DOM (ported from the
 * local sweeper's KeyEntry).
 *
 * The input's value is always empty: keystrokes and pastes are intercepted
 * and collected in a ref, and only a dot count is rendered. It is still a
 * password field, so macOS turns on Secure Event Input while it has focus.
 * A paste is followed by an immediate clipboard wipe.
 */
export function KeyEntry({ onAccount }: { onAccount: (account: LocalAccount, clipboard: ClipboardState) => void }) {
  const buffer = useRef('');
  const [length, setLength] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState>(null);

  const reset = () => {
    buffer.current = '';
    setLength(0);
  };

  const unlock = (clipboardState: ClipboardState = null) => {
    const raw = buffer.current.trim();
    reset();
    if (!KEY_PATTERN.test(raw)) {
      setError('That is not a private key: expected 64 hex characters, with or without 0x.');
      return;
    }
    try {
      const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
      setError(null);
      onAccount(privateKeyToAccount(hex), clipboardState);
    } catch {
      setError('That key could not be loaded.');
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Let shortcuts through, or Cmd+V would never reach onPaste
    if (e.metaKey || e.ctrlKey || e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Enter') return unlock();
    if (e.key === 'Backspace') buffer.current = buffer.current.slice(0, -1);
    else if (e.key === 'Escape') buffer.current = '';
    else if (/^[0-9a-fA-FxX]$/.test(e.key) && buffer.current.length < 66) buffer.current += e.key.toLowerCase();
    setError(null);
    setLength(buffer.current.length);
  };

  const onPaste = async (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    buffer.current = e.clipboardData.getData('text/plain').trim();
    setLength(Math.min(buffer.current.length, 66));
    // Wipe first, so the result can be shown after loading too
    const wiped: ClipboardState = await navigator.clipboard.writeText('').then(
      () => 'cleared' as const,
      () => 'failed' as const
    );
    setClipboard(wiped);
    unlock(wiped);
  };

  const block = (e: { preventDefault: () => void }) => e.preventDefault();

  return (
    <section className="card" aria-labelledby="load-title">
      <div className="card-head">
        <h2 id="load-title">Load wallet</h2>
      </div>
      <div className="load">
        <p id="key-help">Type or paste the private key of the wallet you want to empty.</p>
        <label className="keyfield">
          <span className="visually-hidden">Private key</span>
          <input
            type="password"
            value=""
            onChange={() => {}}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onDrop={block}
            onCopy={block}
            onCut={block}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-lpignore="true"
            data-1p-ignore="true"
            aria-describedby="key-help key-count"
            aria-invalid={error ? true : undefined}
          />
          <span className="dots" aria-hidden="true">
            {length > 0 ? '•'.repeat(length) : <span className="placeholder">Private key</span>}
          </span>
          <span className="hint" id="key-count">{length > 0 ? `${length} characters` : 'Paste or type'}</span>
        </label>
        {error && <p className="field-error" role="alert">{error}</p>}
        {clipboard === 'failed' && <p className="field-warn" role="alert">Could not wipe the clipboard. Copy something else now.</p>}
        <div className="safety">
          <div><ShieldIcon /><span>The key stays in this tab. It is never sent, saved or shown. Only signatures leave.</span></div>
          <div><ShieldIcon /><span>Pasting wipes your clipboard. Typing keeps the key off it entirely.</span></div>
        </div>
        {OFFLINE ? (
          <div className="offline"><span>You are running the offline page from your own disk.</span></div>
        ) : (
          <div className="offline">
            <span>Rather not trust a website with a key? Run the same page from your disk.</span>
            <a href="/offline">Offline page</a>
          </div>
        )}
      </div>
      <div className="actions">
        <button type="button" className="btn btn-primary btn-block" onClick={() => unlock()} disabled={length === 0}>
          Load wallet
        </button>
      </div>
    </section>
  );
}
