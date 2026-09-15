import type { ReactNode } from 'react';

/**
 * Benchmark section layout — DEVELOPMENT ONLY.
 *
 * The banner exists so these pages can never be mistaken for the real game UI,
 * which matters because the "buzzer" here is a network probe and not the
 * Family Feud buzzer (CLAUDE.md: no digital buzzer before Family Feud).
 */
export default function BenchmarkLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: '#0f0f13', color: '#f2f2f5' }}>
      <div
        style={{
          background: '#8a2b2b',
          color: '#fff',
          padding: '8px 16px',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: 0.3,
        }}
      >
        DEVELOPMENT BENCHMARK — not the game. Buzzer here is a network probe only.
      </div>
      {children}
    </div>
  );
}
