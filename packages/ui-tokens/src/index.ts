/**
 * @bb/ui-tokens — shared design primitives for the web app and (later) Unity.
 *
 * PHASE 1 SCOPE: structural placeholder only. These are NEUTRAL tokens — a
 * spacing scale, a type scale and semantic colour slots with placeholder
 * values. There is no Brains & Bacchanal branding here yet.
 *
 * Branded scenes, the scoreboard, round intros and the Family Feud board are
 * Phase 8 (DEVELOPMENT_ROADMAP.md — "Phase 8 — Unity Presentation / Tutorials").
 * Real palette, typography and motion come with that work.
 */

/** Spacing scale in pixels. A 4px base keeps phone layouts on a tight grid. */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

/** Type scale in pixels. */
export const FONT_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 28,
  xxl: 40,
} as const;

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  bold: 700,
} as const;

export const RADIUS = {
  sm: 4,
  md: 8,
  lg: 16,
  pill: 9999,
} as const;

/**
 * Semantic colour slots with PLACEHOLDER values.
 *
 * Named by role rather than by hue so the Phase 8 palette can replace the
 * values without touching call sites.
 */
export const COLOR = {
  background: '#101014',
  surface: '#1b1b21',
  border: '#2e2e36',
  textPrimary: '#f5f5f7',
  textSecondary: '#a1a1ac',
  accent: '#6d6df0',
  success: '#3fa66a',
  warning: '#d99a2b',
  danger: '#d1495b',
} as const;

/** Breakpoints in pixels. Phones are the primary player surface. */
export const BREAKPOINT = {
  phone: 480,
  tablet: 768,
  desktop: 1200,
} as const;

export type SpacingToken = keyof typeof SPACING;
export type FontSizeToken = keyof typeof FONT_SIZE;
export type ColorToken = keyof typeof COLOR;
