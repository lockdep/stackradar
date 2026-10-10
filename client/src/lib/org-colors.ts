import type { OrgColor } from "@/components/providers"

/**
 * The avatar fill for each organisation colour, and the labels the picker shows.
 *
 * The keys are **persisted values**: `organizations.color` is an enum authored in
 * `server/src/db/schema/organizations.ts` and validated by `orgColorSchema`, so
 * they cannot be renamed without a migration. They are Tailwind hue names from
 * before the palette moved to GitHub Primer, and two of them no longer describe
 * what renders — `emerald` is Primer's green, `rose` is Primer's coral. Where key
 * and hue disagree the **label is the truth**; the key is just storage.
 *
 * One solid fill in both themes. Primer's `display-*` namespace is its identity
 * palette (labels, avatars, topics) and it darkens its own emphasis step for dark
 * mode, so there is nothing left for a `dark:` variant to say — the tinted dark
 * treatment this file replaced was hand-rolled around that gap. Every hue carries
 * `text-on-emphasis` at ≥4.86:1. See `--org-*` in `src/app/theme.css`.
 */
export const ORG_COLOR_CLASS: Record<OrgColor, string> = {
    emerald: "bg-org-emerald text-on-emphasis",
    blue: "bg-org-blue text-on-emphasis",
    purple: "bg-org-purple text-on-emphasis",
    orange: "bg-org-orange text-on-emphasis",
    pink: "bg-org-pink text-on-emphasis",
    cyan: "bg-org-cyan text-on-emphasis",
    indigo: "bg-org-indigo text-on-emphasis",
    rose: "bg-org-rose text-on-emphasis",
}

export const ORG_COLOR_OPTIONS: { value: OrgColor; label: string }[] = [
    { value: "emerald", label: "Green" },
    { value: "blue", label: "Blue" },
    { value: "purple", label: "Purple" },
    { value: "orange", label: "Orange" },
    { value: "pink", label: "Pink" },
    { value: "cyan", label: "Cyan" },
    { value: "indigo", label: "Indigo" },
    { value: "rose", label: "Coral" },
]
