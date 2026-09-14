'use client';

import { useCallback, useEffect, useState } from 'react';
import { COLOR, FONT_SIZE, RADIUS, SPACING } from '@bb/ui-tokens';
import type { HealthResponse } from '@bb/protocol';

/**
 * Phase 1 health check page.
 *
 * DEVELOPMENT_ROADMAP.md Phase 1 — "simple web health check".
 *
 * This page exists to prove the web app builds, imports shared packages and can
 * reach the game server. It is NOT the player controller. Room joining, team
 * assignment and the player UI are Phase 4.
 */

const SERVER_URL = process.env['NEXT_PUBLIC_GAME_SERVER_URL'] ?? 'http://localhost:4000';

type Status =
  | { kind: 'loading' }
  | { kind: 'ok'; health: HealthResponse }
  | { kind: 'error'; message: string };

export default function HomePage() {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  const check = useCallback(async (): Promise<void> => {
    setStatus({ kind: 'loading' });
    try {
      const res = await fetch(`${SERVER_URL}/health`, { cache: 'no-store' });
      if (!res.ok) {
        setStatus({ kind: 'error', message: `Server responded ${res.status}` });
        return;
      }
      setStatus({ kind: 'ok', health: (await res.json()) as HealthResponse });
    } catch {
      setStatus({ kind: 'error', message: `Could not reach the game server at ${SERVER_URL}` });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <main
      style={{
        minHeight: '100vh',
        background: COLOR.background,
        color: COLOR.textPrimary,
        padding: SPACING.lg,
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ fontSize: FONT_SIZE.xl, margin: 0 }}>Brains &amp; Bacchanal</h1>
      <p style={{ color: COLOR.textSecondary, marginTop: SPACING.xs }}>
        Where knowledge meets foolishness.
      </p>

      <section
        style={{
          marginTop: SPACING.xl,
          padding: SPACING.md,
          background: COLOR.surface,
          border: `1px solid ${COLOR.border}`,
          borderRadius: RADIUS.md,
          maxWidth: 520,
        }}
      >
        <h2 style={{ fontSize: FONT_SIZE.lg, marginTop: 0 }}>Game server health</h2>

        {status.kind === 'loading' && <p style={{ color: COLOR.textSecondary }}>Checking…</p>}

        {status.kind === 'error' && (
          <p style={{ color: COLOR.danger }} role="alert">
            {status.message}
          </p>
        )}

        {status.kind === 'ok' && (
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: SPACING.sm, margin: 0 }}>
            <dt style={{ color: COLOR.textSecondary }}>Status</dt>
            <dd style={{ margin: 0, color: COLOR.success }}>{status.health.status}</dd>

            <dt style={{ color: COLOR.textSecondary }}>Protocol</dt>
            <dd style={{ margin: 0 }}>{status.health.protocolVersion}</dd>

            <dt style={{ color: COLOR.textSecondary }}>Uptime</dt>
            <dd style={{ margin: 0 }}>{Math.round(status.health.uptimeMs / 1000)}s</dd>
          </dl>
        )}

        <button
          type="button"
          onClick={() => void check()}
          style={{
            marginTop: SPACING.md,
            padding: `${SPACING.sm}px ${SPACING.md}px`,
            fontSize: FONT_SIZE.md,
            color: COLOR.textPrimary,
            background: COLOR.accent,
            border: 'none',
            borderRadius: RADIUS.sm,
            cursor: 'pointer',
          }}
        >
          Check again
        </button>
      </section>

      <p style={{ marginTop: SPACING.xl, color: COLOR.textSecondary, fontSize: FONT_SIZE.sm }}>
        Phase 1 foundation. No gameplay is implemented yet.
      </p>
    </main>
  );
}
