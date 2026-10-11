/**
 * LAYER 1 of `src/app/theme.css`, expressed as a mapping onto the tokens that
 * `@primer/primitives` actually publishes.
 *
 * Keys are our primitive names *without* the `--primer-l-` / `--primer-d-`
 * prefix. Each entry says where that value comes from:
 *
 *   { primer: 'bgColor-default' }
 *       Synced. `pnpm tokens:sync` overwrites our value with Primer's.
 *
 *   { primer: { light: 'a', dark: 'b' } }
 *       Same, but the two themes read different Primer tokens. Needed where
 *       Primer's own light and dark scales are shaped differently.
 *
 *   { primer: 'x', pin: { light: 'reason' } }
 *       Synced in the themes not named; deliberately frozen in the ones that
 *       are. `tokens:check` still *reports* the divergence — a pin means "we
 *       know, and here is why", not "stop looking".
 *
 *   { local: 'reason' }
 *       Primer publishes no equivalent. Ours to own; sync never touches it.
 *
 * Adding a primitive without an entry here fails `tokens:check`, on purpose:
 * every raw colour in the app should have to answer "where did you come from?".
 *
 * Primer renamed its colour tokens between the legacy `--color-*` set (which
 * our names still echo: canvas-*, fg-*, *-subtle) and today's functional set
 * (bgColor-*, fgColor-*, borderColor-*). Note the trap in the middle column:
 * legacy `-subtle` is today's `bgColor-*-muted`, and legacy `-muted` is today's
 * `borderColor-*-muted`. The mapping below is what reconciles the two.
 */

export const TOKEN_MAP = {
    /* ---- Surfaces ---- */
    'canvas-default': { primer: 'bgColor-default' },

    'canvas-subtle': {
        primer: 'bgColor-muted',
        pin: {
            dark: `Primer collapsed dark bgColor-muted onto #151b23, which is also
                   what --primer-d-canvas-overlay resolves to. Taking it would make
                   --surface-muted and --surface-raised the same colour in dark, and
                   every inset fill inside a card (table headers, code blocks, inputs)
                   would vanish. Held at the legacy #161b22 so the ramp keeps three
                   steps. Revisit only with a replacement inset step in hand.`,
        },
    },

    'canvas-inset': {
        primer: 'bgColor-inset',
        pin: {
            light: `Primer now aliases light bgColor-inset to bgColor-muted (#f6f8fa),
                    which is our page canvas. This primitive is --surface-hover, so
                    taking it would make hover invisible on the page and on every
                    secondary button. Held at #eaeef2 — the legacy inset value, and
                    still one real step below the canvas. See T1.`,
        },
    },

    /* Dark-only. Reads bgColor-muted rather than overlay-bgColor: Primer's
       overlay is #010409 (below the canvas), whereas our cards lift above it. */
    'canvas-overlay': { primer: 'bgColor-muted' },

    /* Dark-only. Primer's replacement (control-bgColor-hover) is a step lighter
       and, in light mode, alpha-based — it would change the hover ramp rather
       than restate it. Left as the legacy solid until someone re-screens it. */
    'canvas-hover': { local: 'Legacy --color-canvas-subtle hover step; no like-for-like functional token.' },

    /* ---- Borders ---- */
    'border-default': { primer: 'borderColor-default' },
    'border-emphasis': { primer: 'borderColor-emphasis' },
    'border-active': { primer: 'underlineNav-borderColor-active' },

    /* ---- Text ---- */
    'fg-default': { primer: 'fgColor-default' },
    'fg-muted': { primer: 'fgColor-muted' },
    /* Primer dropped fgColor-subtle; the value survives under a name about
       state rather than hierarchy. We use it for hierarchy (--ink-faint), so
       the name stays ours and only the value is borrowed. */
    'fg-subtle': { primer: 'fgColor-disabled' },
    'fg-secondary': { local: 'Legacy --color-fg-secondary; Primer has no equivalent step between default and muted.' },
    'fg-on-emphasis': { primer: 'fgColor-onEmphasis' },

    /* ---- Accent ---- */
    'accent-fg': { primer: 'fgColor-accent' },
    'accent-emphasis': { primer: 'bgColor-accent-emphasis' },
    'accent-emphasis-hover': {
        local: 'Legacy accent hover; Primer only ships this as button/control component tokens with different values.',
    },
    'accent-muted': { primer: 'borderColor-accent-muted' },
    'accent-subtle': { primer: 'bgColor-accent-muted' },

    /* ---- Success ---- */
    'success-fg': { primer: 'fgColor-success' },
    'success-emphasis': { primer: 'bgColor-success-emphasis' },
    'success-muted': { primer: 'borderColor-success-muted' },
    'success-subtle': { primer: 'bgColor-success-muted' },

    /* ---- Attention ---- */
    'attention-fg': { primer: 'fgColor-attention' },
    'attention-emphasis': { primer: 'bgColor-attention-emphasis' },
    'attention-muted': { primer: 'borderColor-attention-muted' },
    'attention-subtle': { primer: 'bgColor-attention-muted' },

    /* ---- Severe ---- */
    'severe-fg': { primer: 'fgColor-severe' },
    'severe-emphasis': { primer: 'bgColor-severe-emphasis' },
    'severe-muted': { primer: 'borderColor-severe-muted' },
    'severe-subtle': { primer: 'bgColor-severe-muted' },

    /* ---- Danger ---- */
    'danger-fg': { primer: 'fgColor-danger' },
    'danger-emphasis': { primer: 'bgColor-danger-emphasis' },
    /* Not `button-danger-bgColor-hover`. Primer's danger button is *subtle at
       rest* — transparent fill, red label — and turns solid red on hover, so its
       hover token light-resolves to bgColor-danger-emphasis. Ours is solid red at
       rest (`Button variant="danger"`, the delete buttons, DangerousConfirmDialog),
       so importing that token would make hover identical to rest and every
       destructive button would stop responding. A different component model needs
       a different hover step. */
    'danger-emphasis-hover': { local: "Primer's danger button is subtle-at-rest; its hover token is our rest colour." },
    'danger-muted': { primer: 'borderColor-danger-muted' },
    'danger-subtle': { primer: 'bgColor-danger-muted' },

    /* ---- Done (our `--info`) ---- */
    'done-fg': { primer: 'fgColor-done' },
    'done-emphasis': { primer: 'bgColor-done-emphasis' },
    'done-muted': { primer: 'borderColor-done-muted' },
    'done-subtle': { primer: 'bgColor-done-muted' },

    /* ---- Neutral ---- */
    'neutral-emphasis': { primer: 'bgColor-neutral-emphasis' },
    'neutral-muted': { primer: 'borderColor-neutral-muted' },
    'neutral-subtle': { primer: 'bgColor-neutral-muted' },

    /* ---- Data visualisation ---- */
    'data-blue-emphasis': { primer: 'data-blue-color-emphasis' },

    /* ---- Display (organisation identity) ----
       A third namespace again, and the names line up with Primer's current ones
       for once — `display-*` is new enough to have no legacy `--color-*` form.
       Only the `bgColor-emphasis` step is ours; if a hue ever needs the subtle
       treatment, its pair is `display-<hue>-bgColor-muted` + `display-<hue>-fgColor`,
       not the `-muted`/`-subtle` swap that catches people in the block above. */
    'display-green-emphasis': { primer: 'display-green-bgColor-emphasis' },
    'display-blue-emphasis': { primer: 'display-blue-bgColor-emphasis' },
    'display-purple-emphasis': { primer: 'display-purple-bgColor-emphasis' },
    'display-orange-emphasis': { primer: 'display-orange-bgColor-emphasis' },
    'display-pink-emphasis': { primer: 'display-pink-bgColor-emphasis' },
    'display-cyan-emphasis': { primer: 'display-cyan-bgColor-emphasis' },
    'display-indigo-emphasis': { primer: 'display-indigo-bgColor-emphasis' },
    'display-coral-emphasis': { primer: 'display-coral-bgColor-emphasis' },
};

/** Primitives declared under `--primer-l-*` only, and `--primer-d-*` only. */
export const THEME_ONLY = {
    light: [],
    dark: ['canvas-overlay', 'canvas-hover'],
};

/**
 * Literals in `src/lib/brand.ts` that must equal a LAYER 1 **dark** primitive.
 *
 * `src/app/icon.tsx` and `src/app/apple-icon.tsx` render through Satori, which
 * resolves no CSS custom properties, so the app icon's colours have to exist as
 * real strings. Assert each still equals the primitive it was copied from, so
 * the icon cannot drift away from the product behind it.
 *
 * Two entries today, and the machinery is worth more than that suggests: the
 * whole icon *is* `ACCENT`, so drift there is not a detail rendering slightly
 * off, it is the wrong logo.
 *
 * The marketing site runs the same assertion over its OG image. That check
 * exists because the marketing site
 * shipped two different brand greens across a Tailwind major and nothing could
 * catch it; the app icon is the same class of asset, so it gets the same guard.
 *
 * Resolved in `BRAND_THEME`, not per entry: the icon is one image for a
 * two-theme app, and it is the light one because it has to match the landing
 * page favicon and the GitHub org avatar pixel for pixel.
 *
 *   <exported const in brand.ts>: <our primitive name>
 */
export const BRAND_THEME = 'light';
export const BRAND_LITERALS = {
    ACCENT: 'accent-fg',
    SURFACE: 'canvas-default',
};
