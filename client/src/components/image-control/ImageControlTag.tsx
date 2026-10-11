'use client';

import { Menu, MenuButton, MenuHeading, MenuItem, MenuItems, MenuSection, MenuSeparator } from '@headlessui/react';
import { Check, ChevronDown, RotateCcw } from 'lucide-react';
import {
    Badge,
    MENU_HEADING_CLASS,
    MENU_ITEM_CLASS,
    MENU_PANEL_CLASS,
    MENU_SEPARATOR_CLASS,
    MenuRadioItem,
} from '@/components/ui';
import { controlReason, type ControlSignal, type ImageControl } from '@/lib/image-control';

/* The list's words, matching its "Organization images / Third-party images"
   filter rather than the settings page's "Yours". */
const TAG_LABEL: Record<ImageControl, string> = {
    built: 'Organization',
    'third-party': 'Third-party',
    unknown: 'Unconfirmed',
};

const TAG_VARIANT = { built: 'accent', 'third-party': 'neutral', unknown: 'muted' } as const;

const CHOICES: readonly { value: 'built' | 'third-party'; label: string; description: string }[] = [
    { value: 'built', label: 'Organization', description: 'Your organization builds this image.' },
    { value: 'third-party', label: 'Third-party', description: 'Someone else builds it; you upgrade to their fix.' },
];

/**
 * Whose image a row is, as a tag — and, for someone who may decide it, the
 * way to correct it.
 *
 * The answer is kept per **repository** (`image_control_rules`), not per
 * image: correcting one row corrects every image of that repository, in every
 * cluster, and the menu says so before the click. Without `onChange` the tag
 * is a plain badge whose hover says which signal decided.
 */
export function ImageControlTag({
    control,
    detectedBy,
    detail,
    repository,
    onChange,
    className = '',
}: {
    control: ImageControl | null | undefined;
    detectedBy: ControlSignal | null | undefined;
    detail: string | null | undefined;
    /** The repository the answer applies to, as the menu names it. */
    repository: string;
    /** Absent for a reader who cannot change it. `null` resets to what was detected. */
    onChange?: ((next: 'built' | 'third-party' | null) => void) | undefined;
    className?: string;
}) {
    const current = control ?? 'unknown';
    const reason = controlReason(detectedBy ?? null, detail ?? null);

    if (!onChange) {
        return (
            <span title={`${TAG_LABEL[current]} — ${reason}`} className={`shrink-0 ${className}`}>
                <Badge variant={TAG_VARIANT[current]}>{TAG_LABEL[current]}</Badge>
            </span>
        );
    }

    return (
        /* Menu items render in a portal but still bubble through the React
           tree, so this span keeps every click here off the row's own. */
        <span className={`shrink-0 ${className}`} onClick={(e) => e.stopPropagation()}>
            <Menu>
                <MenuButton
                    aria-label={`${TAG_LABEL[current]} image: change who builds ${repository}`}
                    title={`${TAG_LABEL[current]} — ${reason}. Click to change.`}
                    className="cursor-pointer rounded-sm focus:outline-none data-focus:outline-2 data-focus:outline-offset-2 data-focus:outline-accent"
                >
                    <Badge variant={TAG_VARIANT[current]}>
                        {TAG_LABEL[current]}
                        <ChevronDown aria-hidden className="ml-0.5 size-3" />
                    </Badge>
                </MenuButton>
                <MenuItems
                    transition
                    anchor="bottom start"
                    className={`z-50 w-72 [--anchor-gap:4px] ${MENU_PANEL_CLASS}`}
                >
                    <MenuSection>
                        <MenuHeading as="p" className={`${MENU_HEADING_CLASS} pt-1.5`}>
                            Who builds <span className="break-all text-ink">{repository}</span>?
                            <span className="mt-0.5 block font-normal">Applies to every image of this repository.</span>
                        </MenuHeading>
                        {CHOICES.map((choice) => {
                            const isSelected = choice.value === current;
                            return (
                                <MenuItem
                                    key={choice.value}
                                    as={MenuRadioItem}
                                    checked={isSelected}
                                    onClick={() => {
                                        if (!isSelected) onChange(choice.value);
                                    }}
                                    className={`${MENU_ITEM_CLASS} items-start`}
                                >
                                    <span className="min-w-0 flex-1 text-left">
                                        <span className={`block ${isSelected ? 'font-semibold' : ''}`}>
                                            {choice.label}
                                        </span>
                                        <span className="block text-xs text-ink-muted">{choice.description}</span>
                                    </span>
                                    <span className="mt-0.5 size-4 shrink-0">
                                        {isSelected && <Check aria-hidden className="size-4 text-ink-muted" />}
                                    </span>
                                </MenuItem>
                            );
                        })}
                    </MenuSection>
                    {/* Only an answer the org gave can be taken back. */}
                    {detectedBy === 'rule' && (
                        <>
                            <MenuSeparator className={MENU_SEPARATOR_CLASS} />
                            <MenuItem>
                                <button type="button" onClick={() => onChange(null)} className={MENU_ITEM_CLASS}>
                                    <RotateCcw aria-hidden className="size-4 shrink-0 text-ink-muted" />
                                    Reset to what was detected
                                </button>
                            </MenuItem>
                        </>
                    )}
                </MenuItems>
            </Menu>
        </span>
    );
}
