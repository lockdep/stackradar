'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { Menu, MenuButton, MenuHeading, MenuItem, MenuItems, MenuSection, MenuSeparator } from '@headlessui/react';
import { Check, ChevronsUpDown, CircleUser, LogOut } from 'lucide-react';
import { useTheme } from '@/components/providers';
import { THEME_OPTIONS } from './ThemeToggle';
import {
    MENU_HEADING_CLASS,
    MENU_ITEM_CLASS,
    MENU_PANEL_CLASS,
    MENU_SEPARATOR_CLASS,
    MenuRadioItem,
} from './ActionMenu';

export interface UserMenuUser {
    name: string;
    email: string;
    image: string | null;
}

interface UserMenuProps {
    user: UserMenuUser;
    /**
     * `top`: the full row at the foot of the sidebar, panel opening upward.
     * `bottom`: the compact avatar in the mobile top bar, panel opening downward.
     */
    placement: 'top' | 'bottom';
    /** Fires when a link in the menu is followed — the mobile drawer closes on it. */
    onNavigate?: () => void;
}

/** Round where the org avatar is square: a person, not a tenant. */
function UserAvatar({ user, size }: { user: UserMenuUser; size: 'sm' | 'md' }) {
    const dimension = size === 'md' ? 'size-8' : 'size-6';
    if (user.image) {
        // eslint-disable-next-line @next/next/no-img-element -- avatar URL from whichever identity provider signed the user in (GitHub, Google, any OIDC issuer); `next/image` needs the hosts listed up front
        return <img alt="" src={user.image} className={`${dimension} shrink-0 rounded-full bg-surface-hover`} />;
    }
    return (
        <div
            aria-hidden
            className={`${dimension} flex shrink-0 items-center justify-center rounded-full bg-accent-emphasis text-xs font-medium text-on-emphasis`}
        >
            {user.name.charAt(0).toUpperCase()}
        </div>
    );
}

/**
 * The person's menu at the foot of the sidebar: who is signed in, and the
 * things that belong to them rather than to an organization — profile, theme,
 * sign out. Organization switching and management live in the
 * `OrganizationSelector` at the top of the sidebar; the two are deliberately
 * separate triggers so "where am I" and "who am I" each have one home.
 *
 * Theme is a radio group (`menuitemradio` with `aria-checked`) because exactly
 * one preference is active at a time; the rest are ordinary items.
 */
export function UserMenu({ user, placement, onNavigate }: UserMenuProps) {
    const { theme, setTheme } = useTheme();
    const pathname = usePathname();
    const onProfilePage = pathname === '/profile';

    const panelPlacement =
        placement === 'top'
            ? // Opens upward: the trigger sits at the foot of the sidebar, and the
              // panel is the sidebar's width.
              'left-0 bottom-full mb-1 w-full origin-bottom-left'
            : 'right-0 top-full mt-2 w-56 origin-top-right';

    return (
        <Menu as="div" className="relative">
            {placement === 'top' ? (
                <MenuButton className="group flex w-full items-center gap-3 px-2 rounded-md py-2 hover:bg-surface-hover/60 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset">
                    <UserAvatar user={user} size="md" />
                    <div className="flex-1 min-w-0 text-left">
                        <p className="text-sm font-medium text-ink truncate leading-tight">{user.name}</p>
                        {user.email && <p className="text-xs text-ink-muted truncate leading-tight">{user.email}</p>}
                    </div>
                    <ChevronsUpDown
                        aria-hidden
                        className="size-4.5 shrink-0 text-ink-muted transition-colors group-hover:text-ink-secondary"
                    />
                </MenuButton>
            ) : (
                <MenuButton className="flex rounded-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    <span className="sr-only">Open account menu</span>
                    <UserAvatar user={user} size="md" />
                </MenuButton>
            )}

            <MenuItems transition className={`absolute z-50 ${panelPlacement} ${MENU_PANEL_CLASS}`}>
                {/* The top-placement trigger already shows name and email. */}
                {placement === 'bottom' && (
                    <div className="px-2 pt-1.5 pb-2 mb-1 border-b border-edge">
                        <p className="text-sm font-medium text-ink truncate">{user.name}</p>
                        {user.email && <p className="text-xs text-ink-muted truncate">{user.email}</p>}
                    </div>
                )}

                <MenuSection className="pb-1.5">
                    <MenuHeading as="p" className={`${MENU_HEADING_CLASS} pt-1.5`}>
                        Theme
                    </MenuHeading>
                    {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                        <MenuItem
                            key={value}
                            as={MenuRadioItem}
                            checked={theme === value}
                            onClick={() => setTheme(value)}
                            className={MENU_ITEM_CLASS}
                        >
                            <Icon aria-hidden className="size-4 shrink-0 text-ink-muted" />
                            {label}
                            {theme === value && (
                                <Check aria-hidden className="ml-auto size-4 shrink-0 text-ink-muted" />
                            )}
                        </MenuItem>
                    ))}
                </MenuSection>

                <MenuSeparator className={MENU_SEPARATOR_CLASS} />

                <MenuSection className="py-1.5">
                    <MenuItem>
                        <Link
                            href="/profile"
                            onClick={onNavigate}
                            aria-current={onProfilePage ? 'page' : undefined}
                            className={`${MENU_ITEM_CLASS} ${onProfilePage ? 'font-semibold' : ''}`}
                        >
                            <CircleUser aria-hidden className="size-4 shrink-0 text-ink-muted" />
                            Profile
                        </Link>
                    </MenuItem>
                    <MenuItem>
                        <button
                            type="button"
                            onClick={() => signOut({ callbackUrl: '/login' })}
                            className={MENU_ITEM_CLASS}
                        >
                            <LogOut aria-hidden className="size-4 shrink-0 text-ink-muted" />
                            Sign out
                        </button>
                    </MenuItem>
                </MenuSection>
            </MenuItems>
        </Menu>
    );
}
