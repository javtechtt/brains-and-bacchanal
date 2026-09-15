'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { normaliseRoomCode, ROOM_CODE_LENGTH } from '@bb/protocol';
import * as ui from '../../rooms/ui';

/**
 * Manual room-code entry.
 *
 * The QR code is the intended path, but a camera that will not focus, a cracked
 * screen or a guest who arrives late all need a fallback. The Host can read the
 * code aloud and this page accepts it.
 */
export default function JoinLandingPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const canonical = normaliseRoomCode(code);
    if (canonical === null) {
      setError(`Enter the ${ROOM_CODE_LENGTH}-character room code.`);
      return;
    }
    router.push(`/join/${canonical}`);
  };

  return (
    <main style={ui.page}>
      <div style={ui.card}>
        <h1 style={ui.title}>BRAINS &amp; BACCHANAL</h1>
        <p style={ui.tagline}>Where knowledge meets foolishness</p>

        <label style={ui.label} htmlFor="roomCode">
          Room code
        </label>
        <input
          id="roomCode"
          style={{ ...ui.input, ...ui.roomCode, fontSize: ui.FONT_SIZE.xl }}
          value={code}
          maxLength={8}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="BX7K"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          // Codes contain digits, so a text keyboard is right; but never
          // autocorrect it into a word.
          inputMode="text"
        />

        <div style={{ marginTop: ui.SPACING.lg }}>
          <button type="button" style={ui.button} onClick={submit}>
            Continue
          </button>
        </div>

        {error !== null && <p style={ui.errorText}>{error}</p>}

        <p style={{ ...ui.muted, textAlign: 'center', marginTop: ui.SPACING.lg }}>
          Or scan the QR code on the screen.
        </p>
      </div>
    </main>
  );
}
