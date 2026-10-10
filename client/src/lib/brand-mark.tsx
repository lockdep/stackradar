import { ACCENT } from '@/lib/brand';

/**
 * The StackRadar mark: a thick `--accent` ring with nothing inside it.
 *
 * Shared by `src/app/icon.tsx` (the tab favicon) and `src/app/apple-icon.tsx`
 * (the iOS home-screen icon) so the two cannot drift apart — one file owns the
 * stroke proportion, which is the only number the mark has.
 *
 * Rendered through Satori rather than checked in as `icon.svg` for the reason
 * `opengraph-image.tsx` is: an SVG file would restate the brand colour as a
 * literal, and a literal outside `src/lib/brand.ts` is outside
 * `pnpm tokens:check` and free to drift.
 *
 * WHY 11/64 OF STROKE. The hole is the mark — a ring whose centre has closed up
 * is just a dot, and at 16px a favicon has about ten usable pixels across. 15/64
 * closes it, 13/64 leaves a hole too small to read as deliberate, and 9/64 reads
 * thin rather than thick. 11/64 (~17%) holds a visible hole at 16px while still
 * reading as a heavy ring at 128. Re-check at 16px if you ever reweight it.
 *
 * @param diameter  Outer diameter of the ring in pixels. The caller decides how
 *                  much room the ring gets and what, if anything, is behind it.
 */
export function BrandMark({ diameter }: { diameter: number }) {
  return (
    <div
      style={{
        width: diameter,
        height: diameter,
        borderRadius: '50%',
        // Satori sizes borders inside the box, so `diameter` is the ring's
        // outer edge and the hole is whatever is left.
        border: `${diameter * (11 / 64)}px solid ${ACCENT}`,
      }}
    />
  );
}
