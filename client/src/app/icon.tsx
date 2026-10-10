import { ImageResponse } from 'next/og';
import { BrandMark } from '@/lib/brand-mark';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

/**
 * The browser-tab icon: a thick `--accent` ring, transparent inside and out.
 * See `src/lib/brand-mark.tsx` for the mark, its one number, and why it is a
 * copy of the landing page's.
 *
 * The ring runs edge to edge — no field, no padding. At 16px there is nothing
 * to spare, and a ring inset inside a transparent square is just a smaller ring.
 *
 * > [!NOTE]
 * > No field means the ring is the only thing carrying the mark: `--accent`
 * > measures **5.08:1** on a white tab strip and **3.17:1** on dark browser
 * > chrome — both over the 3:1 floor usually applied to meaningful graphics.
 * > Being transparent makes it theme-agnostic, which matters here: the
 * > dashboard is light *and* dark, and a favicon is one image for both.
 *
 * There is deliberately no `favicon.ico` beside this file. Next serves one at
 * `/favicon.ico` whenever it exists, in addition to this route, which is how a
 * pre-Primer blue "S" outlived the redesign on both apps — two icons, one of
 * them unowned. Every browser Next supports reads the `<link rel="icon">` this
 * emits, so the `.ico` is a second source of truth with no consumer.
 *
 * `src/proxy.ts` exempts this route from auth by name. It has no file
 * extension, so the matcher's `.png$` clause does not cover it, and gated it
 * would 307 to /login for exactly the signed-out visitors who see the icon.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex' }}>
        <BrandMark diameter={size.width} />
      </div>
    ),
    { ...size },
  );
}
