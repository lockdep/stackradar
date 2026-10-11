---
name: ui-theming
description: >-
  Domain knowledge for client UI colour and theming: the GitHub Primer palette,
  semantic Tailwind v4 tokens, light/dark switching. Use when styling any client
  component, picking a colour, adding a badge/status/severity indicator, working
  on dark mode, or writing Tailwind classes in client/src.
---

# UI Theming

## The one rule

**All colour is decided in `client/src/app/theme.css`.** Never write a raw palette
class in `client/src` — no `text-red-400`, `bg-gray-50`, `dark:bg-white/5`,
`text-white`, `bg-black/60`. Use a semantic token; it is already correct in both
themes, which is the entire point.

If the token you want doesn't exist, **add it to `theme.css`** rather than
reaching for `dark:`. After the 2026-07-25 migration `dark:` survives in exactly
one file — `ProjectOriginStrip.tsx` (see Exceptions) — treat a second as a smell. A per-theme override is a design decision
with no name; give it one. `nav-active-fg` and `surface-overlay` both started as
`dark:` escape hatches.

## Palette: GitHub Primer

The palette is [GitHub Primer](https://primer.style/foundations/color), taken
verbatim. This was a deliberate decision: Primer's light and dark scales are
already balanced for dense, data-heavy screens, and hand-tuning had produced a
`#060b14` canvas with pure-white text (~19:1) that caused eye strain. **Don't
hand-tune individual values** — if the palette feels wrong, swap the whole
primitive block for another proven system.

`theme.css` has three layers:

| Layer | Contains | When you touch it |
|-------|----------|-------------------|
| 1. Primitives | `--primer-l-*` / `--primer-d-*`, raw Primer values | **Never by hand** — generated, see below |
| 2. Semantics | `--surface`, `--ink`, `--danger`, `--sev-high`… | Adding a new semantic concept |
| 3. Bridge | `@theme inline` → Tailwind utilities | Automatically, when you add to layer 2 |

### LAYER 1 is generated — look the value up, don't invent it

`@primer/primitives` is a **devDependency**. Layer 1 is reconciled against it by
`client/scripts/sync-primer-tokens.mjs`:

```bash
pnpm tokens:find danger    # search Primer's tokens by name or description
pnpm tokens:check          # fail on any unexplained difference — run before committing theme.css
pnpm tokens:sync           # pull Primer's current values into LAYER 1
```

We don't import Primer's CSS at runtime: each theme file declares ~1,900 custom
properties and we use about 50. The package is the *source*, `theme.css` is the
build product.

**Never type a hex into layer 1.** A raw value there is one nobody can trace, and
`tokens:check` fails on it. To add a primitive:

1. `pnpm tokens:find <what you're after>` — prints both theme values, Primer's own
   description, and whether we already have that token under another name. Read
   the values line: plenty of Primer tokens that look right in light are
   alpha-based or collapsed onto a neighbour in dark.
2. Add the primitive to layer 1 **and** an entry to
   `client/scripts/primer-token-map.mjs`. A primitive with no mapping entry fails
   the check — deliberately, so every colour has to answer where it came from.
3. `pnpm tokens:sync`, then wire it into layer 2 with a comment saying what it means.

**The names don't line up, and the mismatch is a trap.** Our primitives echo
Primer's *legacy* `--color-*` names; the package ships the current functional set:

| Ours | Primer today | |
|---|---|---|
| `canvas-default` / `canvas-subtle` | `bgColor-default` / `bgColor-muted` | |
| `fg-default` / `fg-muted` / `fg-subtle` | `fgColor-default` / `fgColor-muted` / `fgColor-disabled` | `fgColor-secondary` and `fgColor-subtle` no longer exist |
| `<family>-fg` | `fgColor-<family>` | |
| `<family>-emphasis` | `bgColor-<family>-emphasis` | |
| `<family>-muted` — our tinted **border** | `borderColor-<family>-muted` | ⚠️ |
| `<family>-subtle` — our tinted **background** | `bgColor-<family>-muted` | ⚠️ |

Those last two are the trap: legacy `-subtle` became `bgColor-*-muted`, so
`--bgColor-danger-muted` is our `danger-subtle`, **not** our `danger-muted`. Check
the mapping file before assuming.

### When Primer and we disagree

`tokens:sync` won't overwrite a primitive carrying a `pin` in
`primer-token-map.mjs`, and `tokens:check` keeps reporting it so it stays a live
decision rather than a stale copy. A pin needs a reason. The three today:

- **`canvas-inset` light** — Primer now aliases it to the page canvas, and it is
  our `--surface-hover`; taking it would delete hover feedback everywhere.
- **`canvas-subtle` dark** — Primer collapsed it onto `canvas-overlay`'s value,
  which would flatten `surface-muted` into `surface-raised` and erase every inset
  fill inside a card.
- **`danger-emphasis-hover`** — marked `local`. Primer's danger button is *subtle
  at rest*, so its hover token is a solid red that happens to equal **our** rest
  colour; importing it would stop every destructive button responding to hover.

All three are one lesson, and it is the one T7-8 already taught: **a Primer token
is tuned for the surface and the component model Primer put it on.** Before
adopting one, check what *we* put it on.

## Token reference

**Neutrals** — every UI surface and every piece of text:

| Token | Use |
|-------|-----|
| `surface` | Page background |
| `surface-raised` | Cards, dialogs, menus, popovers |
| `surface-muted` | Subtle fills, sidebar, table headers |
| `surface-hover` | Hover fills, active nav pills, count chips |
| `surface-overlay` | Panels floating over `backdrop` — the mobile nav drawer, slide-overs |
| `edge` / `edge-strong` | Hairline borders / input + emphasised borders |
| `border-active` | The underline under a **selected tab**, and nothing else |
| `btn-primary` / `btn-primary-hover` | Green fill for the primary action. Reach for it through `<Button variant="primary">`, not by hand |
| `btn-secondary` / `btn-secondary-hover` | Fill for a secondary (non-primary) button — always with `border border-edge` |
| `track` | The unfilled part of a progress bar, toggle, or stepper rail |
| `ink` / `ink-secondary` | Headings / body text |
| `ink-muted` / `ink-faint` | Secondary text / placeholders + decorative icons |
| `on-emphasis` | Text and icons sitting on **any** `*-emphasis` fill |
| `nav-active-fg` | Foreground of a *selected segment in a segmented control* — today only `ThemeToggle` |
| `backdrop` | Modal and drawer scrims (dark in both themes by design) |
| `shadow-resting` / `shadow-floating` | The only two shadows — see Elevation below |

`edge` is a **border** colour. It is not a fill — a secondary button wants
`btn-secondary`, a progress track wants `track`, and a hover fill above
`surface-hover` wants `btn-secondary-hover`. All three used to be `bg-edge`; `bg-edge` should now only
ever appear on a genuine 1px divider.

`nav-active-fg` is deliberately asymmetric — `ink` in light, `accent` in dark,
where a neutral fill on `surface-hover` barely separates from its neighbours. Use
the token; don't re-derive the asymmetry with `dark:` on the next one.

Its scope narrowed in T5. It is for a control where **the fill is the only thing
marking the selection** — a segmented control. It is *not* for navigation: a
sidebar item marks itself current with an indicator bar and a semibold label
(below), so its label stays plain `ink` in both themes.

`border-active` (`#fd8c73` / `#f78166`) is coral, not accent. Primer reserves blue
for links and focus, and a tab underline sits directly beneath a row of clickable
labels. It is only **2.15:1 on the light canvas**, so it must never be the sole
signal — the selected tab label also goes semibold. Don't reach for it outside
`TabBar`.

### The elevation model

Both themes step the same way: **page → card → inset fill.**

| | light | dark |
|---|---|---|
| `surface` (page) | `#f6f8fa` | `#0d1117` |
| `surface-raised` (card) | `#ffffff` | `#151b23` |

The page canvas is deliberately *not* `#ffffff` in light mode. That is what lets the
~90 `bg-surface-raised` cards lift off it without leaning on `border-edge` and a
shadow to be visible at all. Copying GitHub's white `Box` treatment onto a white
canvas — which is what this app did before 2026-07-25 — gives light mode a flat
line-art look while dark mode reads as layered. See
the Primer audit notes.

Two consequences worth internalising:

- **A panel that sits directly on the page canvas belongs on `surface-raised`,
  not `surface-muted`.** In light mode `surface-muted` *is* the canvas colour, so a
  `bg-surface-muted` panel at page level has no fill contrast at all. Empty states
  count as panels here — give them the same lift as the populated card they replace.
- **`surface-muted` is for fills *inside* a raised card** — table headers, code
  blocks, inputs, icon tiles, segmented-control tracks. Against `#ffffff` it reads
  as a proper inset; against the canvas it reads as nothing.

**A panel over the scrim is not part of that ramp.** `surface-overlay`
(light `#ffffff`, dark `#0d1117`) is its own step: with `backdrop` between it and
the page, it doesn't need to lift off anything, and in dark it steps *down* rather
than up — the only value that reads as separate given how close `surface-muted`
and `surface-raised` sit there. See
the Primer audit notes.

### Shadows are tokens too

**Never use Tailwind's `shadow-xs`/`sm`/`lg`/`xl`.** They are black-alpha values
tuned for a white canvas; on `#0d1117` they are invisible, so every card that
leaned on `shadow-xs` to lift only lifted in light mode. There are exactly two:

| Token | Use |
|-------|-----|
| `shadow-resting` | A card or panel sitting *on* the page — pairs with `surface-raised` |
| `shadow-floating` | Anything that leaves the page: menus, dialogs, popovers, chart tooltips — pairs with `surface-overlay` |

Both are defined per theme (LAYER 2 as `--elevation-resting` / `--elevation-floating`,
darker and larger in dark, following Primer). LAYER 2 uses the `--elevation-*` name
because Tailwind owns the `--shadow-*` namespace and LAYER 3 needs it to mint the
utility — a bridge entry of `--shadow-x: var(--shadow-x)` would be circular.

For a shadow in inline CSS (Recharts `contentStyle` is the only case today), read
the LAYER 2 var directly: `boxShadow: 'var(--elevation-floating)'`.

### Charts have their own namespace

Recharts reads these as **raw CSS vars inside props**, never as Tailwind classes,
so they get no LAYER 3 bridge entry and neither grep at the bottom of this file
catches them. Contrast is always measured against **`surface-raised`** — the card
the charts sit on — not the page canvas.

| Token | Use |
|---|---|
| `--chart-series-muted` / `-fill` | **The mark for a plotted series** — line, bar, area outline, and the flat wash under it |
| `--chart-series-1` / `-fill` | Primer's data blue. **Currently unused** — see below |
| `--chart-axis` | Axis lines, tick lines, **and the tooltip cursor** |
| `--chart-grid` | Gridlines |
| `--chart-sev-{critical,high,medium,low}` / `-fill` | Severity marks |

Four rules. Three were real bugs before 2026-07-25; the first is a 2026-07-26 decision.

**Inside a plot, colour means severity.** Every series — total vulnerabilities,
workloads, components — is drawn in `--chart-series-muted`, and the only hue is the
critical+high overlay in `--chart-sev-critical`. `--chart-series-1` (Primer's data
blue) used to mark the single-series workloads and components cards; three
differently-coloured cards in one row of trends spent a second hue on series that
carry no risk signal, and the gray is what makes the red read as the point. The
token stays defined for a chart that is genuinely *categorical* — several series in
one plot that must be told apart — and is not a default for "a chart needs a
colour". `--chart-series-muted` is also the value of `--sev-low`, so the Low
sparkline matches the volume series by construction.

**`--data-*` is not `accent`.** Primer ships a *separate* 17-hue namespace for
chart marks precisely so charts don't borrow UI colour. `--chart-series-1` is
Primer's `data-blue-emphasis` (`#006edb` / `#0576ff`), **not** `accent-fg` — accent
is links, focus rings and selected states, and a plotted series is none of those.
For a year the chart line, the workload links beside it and every focus ring were
the same blue. That still binds whenever the blue comes back.

**A gridline is a line, so it takes `--edge`.** `--chart-grid` was `canvas-inset` —
a *surface* token — measuring **1.17:1** light and **1.14:1** dark on the card. Not
a subtle gridline; an absent one. This is the T4 borrow running backwards.

**Set every colour-bearing Recharts prop explicitly.** Anything left unset gets a
third-party default that no token migration can see. `<Tooltip>` without `cursor`
paints a raw `#ccc` — **10.78:1 in dark**, the brightest object in the plot,
brighter than the data. `<Area>` defaults `fillOpacity` to `0.6`, so always pass
`fillOpacity={1}` and let the `-fill` token carry the alpha.

> [!IMPORTANT]
> **Primer's dark `--data-*` values are tuned against `--bgColor-default`
> (`#0d1117`) — the page canvas. Our charts sit on `--surface-raised`, which in dark
> is `#151b23`, *lighter* than Primer assumed.** Screening all 17 hues against
> `#151b23`, five fall below Primer's own 3:1 mark floor and are **unavailable as
> mark colours**: `gray` (2.79), `green` (2.84), `orange` (2.76), `teal` (2.80),
> `yellow` (2.88). `blue` is in the safe set (4.16:1). Re-screen any hue you add
> against `#151b23`, never against `#0d1117`.

Same trap one level down: Primer's `data-*-muted` fills are tuned for that canvas
too — dark `data-blue-muted` (`#001a47`) collapses to **1.02:1** on our card and the
fill vanishes. That is why the `-fill` tokens are a derived `color-mix` wash of each
series' own mark colour instead: uniform 1.18–1.27:1 in both themes, and it cannot
drift from the mark. See the LAYER 2c comment for why the `@supports` guard and the
`transparent` base are both load-bearing.

**Severity marks are a deliberate deviation, and they do not stack.** The four
`--chart-sev-*` tokens alias `--sev-*` rather than Primer's `data-*`, because they
are product vocabulary (the same colours identify severity in `VulnerabilitySquare`,
every badge and every table) and because the naive `data-*` mapping draws three of
four series from the failing set above — a downgrade from 3.77–6.86:1 to 2.76–4.19:1.

> [!WARNING]
> They are legal **only as marks that never touch.** critical↔high measures
> **ΔE 0.9** (light) / **2.3** (dark) under deuteranopia against a floor of 6, so a
> severity-stacked or grouped chart would be unreadable where the bands meet. One
> sparkline per labelled cell — what `SeverityCards` renders — is the form that
> works. If you need severity composition over time, that constraint is the reason
> you can't just stack it.

### Identity has its own namespace too

`--org-*` is the fill behind an organisation's avatar — eight hues the user picks
from in org settings. It is the one family where **colour carries no meaning**: it
says *which* org, not what state anything is in. That is why it does not borrow
`accent`/`danger` (those mean something) and does not borrow `data-*` (tuned for
chart marks against a card).

It comes from Primer's third colour namespace, `display-*`, which exists for
exactly this — labels, avatars, topic chips. Two things follow, and both are why
this stopped being an exception on 2026-08-15:

- **Primer darkens its own emphasis step**, so the avatar is one solid fill in
  both themes. The tinted `dark:bg-<hue>-400/10` treatment this replaced was
  hand-rolled around a gap that Primer had already closed. Every hue carries
  `text-on-emphasis` at ≥4.86:1 light and ≥6.10:1 dark.
- **`coral` and `red` are the same value in dark.** Primer only separates them in
  light. Don't add a second warm hue expecting them to be distinguishable.

**Never write `bg-org-*` by hand.** `src/lib/org-colors.ts` owns the key→class map
and the picker labels; the components read it. The keys there are *persisted*
values (`organizations.color`, an enum in `server/src/db/schema/organizations.ts`)
and two of them are stale names — `emerald` renders Primer green, `rose` renders
Primer coral. The label is the truth, the key is just storage, and renaming a key
means a migration.

**Status families** — `accent`, `danger`, `attention`, `success`, `info`, `neutral`.
**Severity families** — `sev-critical`, `sev-high`, `sev-medium`, `sev-low`.

Each family has four steps:

| Step | Meaning | Example |
|------|---------|---------|
| bare | Readable foreground on a surface | `text-danger`, `text-sev-high` |
| `-emphasis` | Solid fill (buttons, severity squares, bars) | `bg-accent-emphasis`, `bg-sev-critical-emphasis` |
| `-muted` | Tinted border | `border-danger-muted`, `ring-attention-muted` |
| `-subtle` | Tinted background | `bg-success-subtle`, `bg-info-subtle` |

Pairing rule: text on `*-emphasis` uses `text-on-emphasis`; text on `*-subtle`
uses the matching bare token (`text-danger` on `bg-danger-subtle`).

All six status families have all four steps, `neutral` included — its bare step is
Primer's `fg-muted`, since Primer has no `neutral-fg` role of its own.

`accent` additionally has `-emphasis-hover`; `danger` has it too. Text on any
`*-emphasis` fill is `on-emphasis` — the old `accent-fg` alias for the same value
was removed in T4.

## Buttons: use the component, and know that primary is green

**Don't hand-roll a button.** `components/ui/Button.tsx` owns all four Primer
variants, three sizes, the focus ring, the disabled treatment and the loading
spinner. Before it existed there were 39 hand-written class strings with three
different disabled styles and three different paddings.

```tsx
<Button variant="primary" onClick={…}><Plus className="size-4" />New cluster</Button>
<Button variant="secondary">Cancel</Button>          // the default
<Button variant="danger" loading={isDeleting}>Delete</Button>
<Button variant="invisible">Rotate API key</Button>
```

Sizes are `sm` (h-7) / `md` (h-8, default) / `lg` (h-10); `fullWidth` for
`w-full`; `loading` shows a spinner *and* disables. For a `next/link` that must
look like a button, use `buttonClasses({ variant, size })` — same styles, no
`<button>` element.

Buttons in the same row should share a size — the heights are fixed precisely so
they line up. That cuts both ways: **migrating one button in a dialog footer means
migrating its sibling too**, or a `h-10` `<Button size="lg">` ends up beside a
hand-rolled `px-4 py-2`.

Narrowing an icon-only button wants `pl-2 pr-2`, **not `px-2`** — see the padding
warning under Tables; it applies to every primitive whose `className` you override,
not just cells.

**Primary is green, not blue.** `--btn-primary` is Primer's
`#1f883d` / `#238636`. This is not a stylistic tweak — in GitHub's language blue
is for links, focus rings and *selected* states, and it is essentially never a
filled action. That's why the migration on 2026-07-25 changed only the ~20 real
buttons and deliberately left `bg-accent-emphasis` in place on avatars, toggle
"on" states, progress fills, stepper rails, timeline dots and the "Recommended"
plan badge. Before you swap an `accent` for a `btn-primary`, ask whether the
thing is an *action* or a *state*.

## Tables: use the component, and never hand-assemble one

**Don't hand-roll a table.** `components/ui/Table.tsx` is Primer's DataTable and
owns the container, the three densities, the header treatment, row hover and the
sortable-header ARIA contract. Before it existed there were 21 hand-assembled
tables in **four dialects with ten different header treatments**, two of which
picked `surface-muted` and were invisible in dark.

```tsx
<TableContainer>                        {/* card | section | plain */}
    <Table density="spacious" aria-label="Clusters">
        <TableHead>                     {/* renders its own <tr> */}
            <TableHeader>Name</TableHeader>
            <SortableHeader column="name" sortColumn={…} sortDirection={…} onSort={…}>
                Name
            </SortableHeader>
            <TableHeader align="end">Workloads</TableHeader>
            <TableHeader srOnly>Open</TableHeader>
        </TableHead>
        <TableBody>
            <TableRow onClick={…}><TableCell>…</TableCell></TableRow>
        </TableBody>
        <TableFoot>…</TableFoot>        {/* also renders its own <tr> */}
    </Table>
</TableContainer>
```

| Decision | Where it lives |
|---|---|
| Density — `condensed` / `normal` (default) / `spacious` | `Table density=` |
| Container chrome — `card` (own panel) / `section` (full-bleed `border-y`) / `plain` (already in a card) | `TableContainer variant=` |
| Header fill + `border-b`, sentence case, `text-xs font-semibold text-ink-muted` | `TableHead` / `TableHeader` |
| Row hover, `cursor-pointer`, the `selected` accent fill | `TableRow` (`onClick` implies `hoverable`) |
| `<button>` inside `<th aria-sort>`, chevron on hover *and* focus | `SortableHeader` |

`align="start|center|end"` on cells and headers; `srOnly` on a header labels an
actions/chevron column without showing text. `TableEmpty` stands in for
`TableBody` so the header and container survive an empty result.

Two escape hatches, both there for one caller: `TableBody divided={false}` (a row
draws its own rule — SBOM history runs a timeline rail down its leading column)
and `TableHead filled={false}` (a nested table already on a tinted backdrop).

**Header case is sentence case.** `uppercase tracking-wide` is the Tailwind-UI
idiom, not Primer — the same finding as the sidebar group headings in T5.

> [!WARNING]
> **Overriding padding via `className` only works per-side.** Tailwind resolves
> conflicts by the order it *emits* utilities, never the order you write them, and
> it emits shorthand → axis → side, then ascending by value. So `pl-0` and `pl-8`
> beat the primitive's `px-3`, but **`px-0` and `px-2` silently lose to it**. Use
> `pl-0 pr-0`. This is about `className` overrides on *any* primitive — it caught
> `Button` too — not only `Table` cells.

## Radius: one card value

Primer has one Box radius, 6px. The scale is four values and nothing else:

| Utility | Use |
|---|---|
| `rounded-sm` (4px) | Inline code, chips, badges, `kbd`, checkboxes |
| `rounded-md` (6px) | **Cards, panels, table containers, inputs, menus, icon tiles, buttons** |
| `rounded-xl` (12px) | Dialogs only — Primer's Dialog radius |
| `rounded-full` | Avatars, dots, pills |

`rounded-lg` and `rounded-2xl` are Tailwind defaults nobody chose; they were swept
out on 2026-07-25 (T6-11) and should not come back. Bare `rounded` is Tailwind v4's
deprecated alias for `rounded-sm` — write the explicit name.

## Navigation: state is never carried by colour alone

Primer marks a selected nav item with **two or three stacked signals**, and colour
is the weakest of them. Copying only the colour is how both of these components
drifted before T5.

**Tabs — use `TabBar`, don't hand-roll one.** `components/ui/TabBar.tsx` is
Primer's UnderlineNav in its UnderlinePanels form and is already used by all four
tabbed views. Selected = **semibold label** + a 2px `after:bg-border-active`
underline. The label colour is `text-ink` in *both* states — a blue label under a
tab strip reads as a link. Hover is a `surface-hover` pill; the underline doesn't
move. It also owns the ARIA contract (`aria-controls`, roving `tabIndex`,
arrow/Home/End keys) — pair every `TabBar` with `TabPanel`, or the `role="tab"` is
a lie to screen readers.

**Sidebar items** mark themselves with `aria-current="page"` plus three things: a
`surface-hover` fill, a semibold label, and a 4px `after:bg-accent-emphasis`
indicator bar inset 4px vertically and offset 8px outside the leading edge
(Primer's `activeIndicatorLine`). No `shadow-sm` — Primer doesn't shadow nav items.
Leading icons are `size-4 text-ink-muted` **in every state**; don't dim them to
`ink-faint`, which only just clears the 3:1 icon floor. Group headings are
`text-xs font-semibold text-ink-muted`, **sentence case** — the uppercase
`tracking-wider` treatment is a Tailwind-UI idiom, not Primer.

## Picking a colour

| You need | Use |
|----------|-----|
| Any button | `<Button variant="primary\|secondary\|danger\|invisible">` — see above |
| Any table | `<TableContainer>` + `<Table>` — see Tables above |
| A tab strip | `<TabBar>` + `<TabPanel>` — see Navigation above |
| Selected tab underline (only inside `TabBar`) | `after:bg-border-active` + `font-semibold` label |
| Current nav item (only inside `Sidebar`) | `bg-surface-hover font-semibold text-ink after:bg-accent-emphasis` |
| Primary button fill (only inside `Button`) | `bg-btn-primary hover:bg-btn-primary-hover text-on-emphasis` |
| Secondary / cancel fill (only inside `Button`) | `bg-btn-secondary hover:bg-btn-secondary-hover border border-edge` |
| Link / interactive text | `text-accent hover:underline` |
| Error text or icon | `text-danger` |
| Warning callout | `bg-attention-subtle border border-attention-muted text-attention` |
| Success state | `text-success` / `bg-success-subtle` |
| Vulnerability severity | `sev-*` — **not** `danger`/`attention`. Severity is its own vocabulary |
| An organisation's avatar | `ORG_COLOR_CLASS` from `lib/org-colors.ts` — never a `bg-org-*` class by hand |
| Inverted tooltip | `bg-ink text-surface` |
| Recharts colours | `var(--chart-series-muted)`, `var(--chart-axis)`, `var(--chart-sev-*)` — raw CSS vars, not classes. See Charts above |

Severity maps to Primer as: critical → danger red, high → severe orange,
medium → attention yellow, low → neutral gray.

`Badge` variants are semantic, not colour names: `neutral`, `muted`, `accent`,
`success`, `attention`, `danger`, `info`, `inverted`.

## Mechanism

Attribute-driven, not `prefers-color-scheme`, so an explicit "light" choice beats
a dark OS preference:

1. Inline script in `client/src/app/layout.tsx` sets `data-theme` on `<html>`
   **before first paint** (localStorage key `sr-theme`) — no flash of wrong theme.
2. `ThemeProvider` (`components/providers/ThemeProvider.tsx`) keeps it in sync
   afterwards via `useSyncExternalStore`.
3. `@custom-variant dark` in `globals.css` keys on `[data-theme="dark"]`.

If you change the storage key, change it in **both** the inline script and
`THEME_STORAGE_KEY`.

## Gotchas

- **Tailwind silently drops unknown class names.** A typo'd token (`bg-accnt-emphasis`)
  is not a build error — it renders as nothing. Cross-check after bulk edits (below).
- **In dark, `surface-raised` (`#151b23`) and `surface-muted` (`#161b22`) are nearly
  identical.** Never stack one directly on the other and expect a visible step —
  use `surface-hover` for the raised element, or `surface-overlay` if it's a panel
  over the scrim. This is what made the sidebar's active nav pill invisible before
  the fix, and it recurred on ~20 table headers and row hovers.
- **`surface-muted` is invisible in *one* theme wherever you put it**, because it
  is the light page canvas *and* a near-twin of the dark card. A `<thead>` fill or
  a row `hover:` therefore wants **`surface-hover`**, which steps clearly off
  `surface`, `surface-raised` and `surface-muted` in both themes. Reserve
  `surface-muted` for inset fills that already carry a border — inputs, code
  blocks, icon tiles.
- **An opacity modifier cannot rescue an invisible fill.** `bg-surface-muted/50`
  over `surface-raised` was reached for to "soften" a header on four tables; it
  resolves to `#fbfcfd` on white and `#151b22` on `#151b23`. If the fill needs
  softening, the token is wrong.
- Opacity modifiers work on tokens (`bg-accent-emphasis/50`), including on the
  `rgba()`-valued `*-subtle` tokens.
- Contrast floors: 4.5:1 for text, 3:1 for `ink-faint` and decorative icons.
  `ink-faint` on `surface-hover` fails — use `ink-muted` there.

## Exceptions — leave these alone

These are the only expected hits from either grep below. Anything else is a finding.

| Location | Raw palette | `dark:` | Why |
|----------|---|---|-----|
| `components/clusters/ConnectClusterInstructions.tsx` | ✅ | — | Deliberately always-dark code panel (`variant="dark"`) |
| `components/project-detail/ProjectOriginStrip.tsx` | ✅ | ✅ | ArgoCD brand orange on the `SiArgo` logo |

## Verifying a change

```bash
cd client && pnpm build          # unknown tokens do NOT fail this — see below
```

Find classes referencing tokens that don't exist (the silent failure mode):

```bash
grep -oP '(?<=^    --color-)[a-z-]+(?=:)' src/app/theme.css | sort -u > /tmp/defined.txt
grep -rhoP '\b(?:bg|text|border|ring|outline|divide|placeholder|fill|stroke)-(?:surface|edge|ink|accent|danger|attention|success|info|neutral|sev|org|on-emphasis|nav-active-fg|backdrop|btn-primary|btn-secondary|track|border-active)[a-z-]*' \
  --include='*.tsx' src \
  | sed -E 's/^(bg|text|border|ring|outline|divide|placeholder|fill|stroke)-//' | sort -u > /tmp/used.txt
comm -23 /tmp/used.txt /tmp/defined.txt    # must be empty
```

Find raw palette classes that crept back in (should return only the three exceptions):

```bash
grep -rnP '\b(bg|text|border|ring|divide|fill|stroke|placeholder)-((gray|slate|zinc|neutral|red|amber|yellow|orange|emerald|green|blue|cyan|indigo|violet|purple|pink|rose|teal|sky)-[0-9]+|white|black)(\/[0-9]+)?\b' \
  --include='*.tsx' src
```

The digit is required on purpose: `neutral` is both a Tailwind colour and one of
our token families, so `-?[0-9]*` would flag `bg-neutral-emphasis` as a false positive.

**Neither grep above sees a chart.** Both scan `className` strings; every chart
colour is a raw `var()` inside a Recharts prop. These three are the chart-layer
equivalents:

```bash
# A colour-bearing prop taking a literal instead of a token.
# Expected hits: the Google logo's four brand paths in `app/login/page.tsx` and
# `app/invite/[token]/page.tsx` (#4285F4 / #34A853 / #FBBC05 / #EA4335) — a brand
# mark is not themeable. Anything else is a finding.
grep -rnE '(stroke|fill|stopColor|backgroundColor|color)\s*[:=]\s*.?#[0-9a-fA-F]{3,8}' \
  --include='*.tsx' src

# A functional/status token used as a chart mark (charts have their own namespace)
grep -rnE "var\(--(accent|danger|severe|attention|success|info|neutral)" \
  --include='*.tsx' src

# A surface token used as a chart line
grep -nE '^\s*--chart-(grid|axis).*canvas' src/app/theme.css

# Every --chart-* used in src must exist in theme.css (the silent-failure mode)
comm -23 \
  <(grep -rhoE 'var\(--chart-[a-z0-9-]+\)' --include='*.tsx' src | sed -E 's/var\(|\)//g' | sort -u) \
  <(grep -oE '^\s+--chart-[a-z0-9-]+' src/app/theme.css | tr -d ' ' | sort -u)
```

None of them would have caught T7-6's `#ccc`, because it lives in
`node_modules/recharts/lib/component/Cursor.js` and is never written in `src` at
all. The only defence against that class is the rule above — set every
colour-bearing Recharts prop explicitly rather than inheriting a default.

`/dev/charts` is a dev-only harness rendering every chart state on one page, in
both themes. Use it for the visual half of a chart change; a grep can't see a
gradient or a mark weight.

## Related

The **landing page is a separate app** with its own dark-only emerald brand
(`#34d399` on `#060b14`) and does **not** share these tokens. Changing the
dashboard palette does not change the marketing site, and vice versa.
