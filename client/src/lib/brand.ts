/**
 * The two theme colours that have to exist as literal strings.
 *
 * `src/app/icon.tsx` and `src/app/apple-icon.tsx` render through Satori at
 * build time, which resolves no CSS custom properties — `var(--accent)`
 * reaches it as an uninterpretable string. So the app icon reads its colours
 * from here.
 *
 * > [!IMPORTANT]
 * > Both values below are copies of LAYER 1 **light** primitives in
 * > `src/app/theme.css`. Do not hand-edit one. `pnpm tokens:check` asserts each
 * > still equals the primitive it was copied from (the mapping is
 * > `BRAND_LITERALS` in `scripts/primer-token-map.mjs`, resolved in the theme
 * > named by `BRAND_THEME` there) and fails the build if they part company.
 *
 * NOTE ON NAMING. The names match `landing-page/src/lib/brand.ts` on purpose:
 * the mark is Primer blue — the same `--accent` that colours links and focus
 * rings in this app — so `ACCENT` means the same thing on both sides and
 * `brand-mark.tsx` can be a byte-for-byte copy of the landing page's.
 *
 * NOTE ON THEME. The dashboard is light *and* dark, but a favicon is one image.
 * The tab icon is a transparent ring, so it needs no field at all; the only
 * consumer of `SURFACE` is the iOS icon, which cannot be transparent. Both are
 * **light** values regardless of the theme the user is in, because the mark has
 * to be the same pixels as stackradar.io's favicon and the GitHub org avatar —
 * one logo, not one per theme.
 *
 * The check treats a raw colour exported from this file without a
 * `BRAND_LITERALS` entry as an error, so unused literals do not accumulate here
 * quietly.
 */

/** `--primer-l-accent-fg` — the brand blue; the ring, and the whole mark. */
export const ACCENT = '#0969da';

/** `--primer-l-canvas-default` — the iOS icon's field. Nothing else uses it. */
export const SURFACE = '#ffffff';
