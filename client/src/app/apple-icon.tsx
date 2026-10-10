import { ImageResponse } from 'next/og';
import { SURFACE } from '@/lib/brand';
import { BrandMark } from '@/lib/brand-mark';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/**
 * The iOS home-screen icon — the same ring as `icon.tsx`, with the two changes
 * iOS forces.
 *
 * **It has an opaque field.** iOS does not honour transparency in a home-screen
 * icon; it composites whatever it is given onto black. So the ring's hole would
 * fill with black regardless — this just makes that colour a decision rather
 * than a default, and `--surface` is the canvas the rest of the brand sits on.
 * The favicon stays transparent; only this one needs a field.
 *
 * **The ring is inset to 80% of the canvas.** iOS masks the image to its own
 * squircle. A full-bleed ring, like the favicon's, would sit tangent to the
 * mask at four points and read as clipped.
 *
 * Worth having on the dashboard specifically: this is the icon a customer gets
 * if they save app.stackradar.io to a phone home screen.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: SURFACE,
        }}
      >
        <BrandMark diameter={size.width * 0.8} />
      </div>
    ),
    { ...size },
  );
}
