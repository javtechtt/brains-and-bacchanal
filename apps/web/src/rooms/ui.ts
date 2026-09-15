import { COLOR, FONT_SIZE, FONT_WEIGHT, RADIUS, SPACING } from '@bb/ui-tokens';
import type { CSSProperties } from 'react';

/**
 * Shared styling for the production lobby pages.
 *
 * Built from @bb/ui-tokens rather than literal values, so the Phase 8 branding
 * pass changes the palette in one place. This is deliberately plain: Phase 4 is
 * a functional lobby, and polished presentation is explicitly out of scope.
 *
 * Phone-first — every player-facing surface here is read on a phone, held
 * one-handed, in a room with the lights down.
 */

export const page: CSSProperties = {
  minHeight: '100vh',
  background: COLOR.background,
  color: COLOR.textPrimary,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: SPACING.lg,
  boxSizing: 'border-box',
};

export const card: CSSProperties = {
  width: '100%',
  maxWidth: 420,
  background: COLOR.surface,
  border: `1px solid ${COLOR.border}`,
  borderRadius: RADIUS.lg,
  padding: SPACING.lg,
  boxSizing: 'border-box',
};

export const title: CSSProperties = {
  fontSize: FONT_SIZE.lg,
  fontWeight: FONT_WEIGHT.bold,
  letterSpacing: 0.5,
  margin: 0,
  textAlign: 'center',
};

export const tagline: CSSProperties = {
  fontSize: FONT_SIZE.xs,
  color: COLOR.textSecondary,
  textAlign: 'center',
  marginTop: SPACING.xs,
  marginBottom: SPACING.lg,
};

export const label: CSSProperties = {
  display: 'block',
  fontSize: FONT_SIZE.sm,
  color: COLOR.textSecondary,
  marginBottom: SPACING.xs,
};

export const input: CSSProperties = {
  width: '100%',
  padding: SPACING.md,
  // 16px or larger, or iOS Safari zooms the whole page when the field focuses.
  fontSize: FONT_SIZE.md,
  background: COLOR.background,
  color: COLOR.textPrimary,
  border: `1px solid ${COLOR.border}`,
  borderRadius: RADIUS.md,
  boxSizing: 'border-box',
};

export const button: CSSProperties = {
  width: '100%',
  padding: SPACING.md,
  fontSize: FONT_SIZE.md,
  fontWeight: FONT_WEIGHT.medium,
  background: COLOR.accent,
  color: COLOR.textPrimary,
  border: 'none',
  borderRadius: RADIUS.md,
  cursor: 'pointer',
  // Comfortably above the ~44px minimum touch target.
  minHeight: 48,
};

export const secondaryButton: CSSProperties = {
  ...button,
  background: 'transparent',
  border: `1px solid ${COLOR.border}`,
  color: COLOR.textSecondary,
};

export const roomCode: CSSProperties = {
  fontSize: FONT_SIZE.xxl,
  fontWeight: FONT_WEIGHT.bold,
  letterSpacing: 6,
  textAlign: 'center',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export const errorText: CSSProperties = {
  color: COLOR.danger,
  fontSize: FONT_SIZE.sm,
  marginTop: SPACING.sm,
  textAlign: 'center',
};

export const muted: CSSProperties = {
  color: COLOR.textSecondary,
  fontSize: FONT_SIZE.sm,
};

/** Colour for a connection status pill. */
export function statusColor(status: string): string {
  if (status === 'connected') return COLOR.success;
  if (status === 'connecting' || status === 'reconnecting') return COLOR.warning;
  return COLOR.textSecondary;
}

export { COLOR, FONT_SIZE, FONT_WEIGHT, RADIUS, SPACING };
