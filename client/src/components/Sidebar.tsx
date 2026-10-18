'use client';

import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
    Dialog,
    DialogBackdrop,
    DialogPanel,
    TransitionChild,
    Menu as HeadlessMenu,
    MenuButton,
    MenuItem,
    MenuItems,
    MenuSeparator,
} from '@headlessui/react';
import {
    Menu,
    X,
    Server,
    Shield,
    ShieldAlert,
    Boxes,
    Container,
    Gauge,
    Newspaper,
    Check,
    MessageSquareText,
    CircleHelp,
    BookOpen,
    LifeBuoy,
    Mail,
    Copy,
    Terminal,
} from 'lucide-react';
import { OrganizationSelector, UserMenu, MENU_ITEM_CLASS, MENU_PANEL_CLASS, type UserMenuUser } from '@/components/ui';
import { FeedbackDialog } from '@/cloud';
import { useCopy } from '@/components/ui/CodeBlock';
import { useRuntimeConfig } from '@/components/providers';
import { SearchTrigger } from '@/components/search';
import { CLI_PAGE_URL } from '@/lib/cli';
import { SiDocker } from 'react-icons/si';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Two groups, separated by a Primer NavList.Divider rather than headings.
 * The first is the daily workflow in its order — the verdict, what to fix,
 * the evidence, what changed; the second is the infrastructure those
 * numbers are counted over, which is setup rather than workflow and so
 * sits below the line however often it is opened.
 */
const navigation: {
    name: string;
    href: string;
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}[][] = [
    [
        { name: 'Dashboard', href: '/', icon: Gauge },
        // The Dashboard's severity cards link into it: every cluster's
        // Vulnerabilities tab folded into one org-wide list.
        { name: 'Vulnerabilities', href: '/vulnerabilities', icon: ShieldAlert },
        // Its neighbour on the Dashboard too — the Packages trend card links
        // here: every cluster's Packages tab folded into one org-wide list.
        { name: 'Packages', href: '/packages', icon: Boxes },
        // Every cluster's Containers tab folded into one org-wide list, worst
        // first — the entity the whole model is built on, reachable without
        // going through a cluster.
        { name: 'Containers', href: '/containers', icon: Container },
        // The same fleet counted by what runs rather than where: one row per
        // image, however many containers share it. The whale is the image
        // mark everywhere else (`EntityIcon`).
        { name: 'Images', href: '/images', icon: SiDocker },
        // What changed, day by day — the wall the rest of the product's
        // numbers are deltas of.
        { name: 'Feed', href: '/feed', icon: Newspaper },
    ],
    [{ name: 'Clusters', href: '/clusters', icon: Server }],
];

function isNavActive(pathname: string, href: string) {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname.startsWith(href + '/');
}

function classNames(...classes: string[]) {
    return classes.filter(Boolean).join(' ');
}

/**
 * Primer NavList item. The current item is marked with `aria-current="page"` and
 * carries three signals, the way Primer stacks them: a `surface-hover` fill, a
 * semibold label, and a 4px accent indicator bar sitting just outside the item's
 * leading edge. Because the bar and the weight do the work, the label stays plain
 * `ink` in both themes — it does not need `nav-active-fg`.
 */
const NAV_ITEM_BASE =
    'group relative flex w-full items-center gap-x-2 rounded-md px-2 py-1.5 text-sm ' +
    "after:absolute after:top-1 after:-left-2 after:h-[calc(100%-0.5rem)] after:w-1 after:rounded-md after:content-['']";

function NavItem({
    href,
    icon: Icon,
    label,
    current,
    onNavigate,
}: {
    href: string;
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    label: string;
    current: boolean;
    onNavigate?: () => void;
}) {
    return (
        <Link
            href={href}
            onClick={onNavigate}
            aria-current={current ? 'page' : undefined}
            className={classNames(
                NAV_ITEM_BASE,
                'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                current
                    ? 'bg-surface-hover font-semibold text-ink after:bg-accent-emphasis'
                    : 'text-ink-secondary hover:bg-surface-hover/60 hover:text-ink',
            )}
        >
            <Icon aria-hidden className="size-4 shrink-0 text-ink-muted" />
            {label}
        </Link>
    );
}

/**
 * "Send feedback" — opens the first-party feedback dialog, which stores the
 * message in our own database (POST /api/feedback) for the admin dashboard's
 * Feedback tab.
 */
function FeedbackItem() {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <li>
            <button
                type="button"
                onClick={() => setIsOpen(true)}
                className={classNames(
                    NAV_ITEM_BASE,
                    'cursor-pointer text-ink-secondary hover:bg-surface-hover/60 hover:text-ink',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                )}
            >
                <MessageSquareText aria-hidden className="size-4 shrink-0 text-ink-muted" />
                Send feedback
            </button>
            <FeedbackDialog isOpen={isOpen} onClose={() => setIsOpen(false)} />
        </li>
    );
}

/**
 * The live demo's stand-in for "Send feedback" (the server would refuse the
 * post): the visitor's next step, which is the same CLI command the banner
 * offers — a result on their own cluster, no account.
 */
function ScanYourClusterItem() {
    return (
        <li>
            <a
                href={CLI_PAGE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={classNames(
                    NAV_ITEM_BASE,
                    'cursor-pointer text-ink-secondary hover:bg-surface-hover/60 hover:text-ink',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                )}
            >
                <Terminal aria-hidden className="size-4 shrink-0 text-ink-muted" />
                Scan your own cluster
            </a>
        </li>
    );
}

/**
 * "Help" — an upward ActionMenu next to "Send feedback" pointing at the public
 * docs (they live on the landing site, so these are plain external links) and
 * the support address. The address is shown verbatim rather than hidden behind
 * a "Contact" label, matching the landing footer's convention.
 */
const HELP_LINKS = [
    { label: 'Documentation', href: 'https://stackradar.io/docs', icon: BookOpen },
    { label: 'Troubleshooting', href: 'https://stackradar.io/docs/troubleshooting', icon: LifeBuoy },
];

/** The community edition's help channel: GitHub Discussions, not a mailbox. */
const DISCUSSIONS_LINK = {
    label: 'GitHub Discussions',
    href: 'https://github.com/lockdep/stackradar/discussions',
    icon: MessageSquareText,
};

/** The address the marketing site publishes too; change both together. */
const CONTACT_EMAIL = 'contact@stackradar.io';

function HelpItem({ support }: { support: boolean }) {
    const { copied, copy } = useCopy(CONTACT_EMAIL);
    const links = support ? HELP_LINKS : [...HELP_LINKS, DISCUSSIONS_LINK];

    return (
        <li>
            <HeadlessMenu as="div" className="relative">
                <MenuButton
                    className={classNames(
                        NAV_ITEM_BASE,
                        'cursor-pointer text-ink-secondary hover:bg-surface-hover/60 hover:text-ink',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset',
                    )}
                >
                    <CircleHelp aria-hidden className="size-4 shrink-0 text-ink-muted" />
                    Help
                </MenuButton>
                <MenuItems
                    transition
                    className={classNames(
                        'absolute bottom-full left-0 mb-1 w-full origin-bottom-left',
                        MENU_PANEL_CLASS,
                    )}
                >
                    {links.map(({ label, href, icon: Icon }) => (
                        <MenuItem key={href}>
                            <a href={href} target="_blank" rel="noreferrer" className={MENU_ITEM_CLASS}>
                                <Icon aria-hidden className="size-4 shrink-0 text-ink-muted" />
                                {label}
                            </a>
                        </MenuItem>
                    ))}
                    {support && <MenuSeparator className="my-1 h-px bg-edge" />}
                    {support && (
                        <MenuItem>
                            {/* Deliberately not a mailto link — it copies the address instead.
                            preventDefault keeps Headless UI from closing the menu on the
                            click, so the "Copied" confirmation is actually visible. */}
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.preventDefault();
                                    void copy();
                                }}
                                className={MENU_ITEM_CLASS}
                            >
                                <Mail aria-hidden className="size-4 shrink-0 text-ink-muted" />
                                <span className="truncate">{CONTACT_EMAIL}</span>
                                {copied ? (
                                    <Check aria-hidden className="ml-auto size-4 shrink-0 text-success" />
                                ) : (
                                    <Copy aria-hidden className="ml-auto size-4 shrink-0 text-ink-muted" />
                                )}
                                <span aria-live="polite" className="sr-only">
                                    {copied ? 'Email address copied' : 'Copy email address'}
                                </span>
                            </button>
                        </MenuItem>
                    )}
                </MenuItems>
            </HeadlessMenu>
        </li>
    );
}

/** Primer NavList.GroupHeading: 12px semibold muted, sentence case — no uppercase. */
function NavGroupHeading({ children, id }: { children: ReactNode; id: string }) {
    return (
        <p id={id} className="mb-1.5 px-2 text-xs font-semibold text-ink-muted">
            {children}
        </p>
    );
}

interface SidebarProps {
    sidebarOpen: boolean;
    setSidebarOpen: (open: boolean) => void;
    onOrganizationChange: () => void;
    userName: string;
    userImage: string | null;
    userEmail: string;
    isAdmin?: boolean;
}

function NavItems({
    user,
    onOrganizationChange,
    onNavigate,
    isAdmin,
}: {
    user: UserMenuUser;
    onOrganizationChange: () => void;
    onNavigate?: () => void;
    isAdmin?: boolean;
}) {
    const pathname = usePathname();
    const { demoMode, edition } = useRuntimeConfig();
    const handleOrgChange = () => {
        onOrganizationChange();
        onNavigate?.();
    };

    return (
        // The active indicator bar overhangs each item by 8px; the container's
        // px-3 leaves room for it without clipping.
        <ul role="list" className="flex flex-1 flex-col gap-y-0.5">
            <li>
                {/* Which tenant every number below belongs to. Settings, members
                    and billing live inside this menu, next to the switcher —
                    everything about *an* organization in one place. */}
                <OrganizationSelector onOrganizationChange={handleOrgChange} onNavigate={onNavigate} />
            </li>
            <li className="mt-1">
                {/* Go anywhere by typing: the org-wide palette (⌘K, `/`), a
                    shell-level entry point rather than a page filter. */}
                <SearchTrigger variant="sidebar" />
            </li>
            {/* The primary groups carry no headings: they are the sidebar, not
                sections of it, so a divider is enough to keep them apart. Admin
                below keeps its heading because it is a section. */}
            {navigation.map((group, index) => (
                <li key={index} className={index === 0 ? 'mt-3' : 'mt-2 border-t border-edge pt-2'}>
                    <ul role="list" className="space-y-0.5">
                        {group.map((item) => (
                            <li key={item.name}>
                                <NavItem
                                    href={item.href}
                                    icon={item.icon}
                                    label={item.name}
                                    current={isNavActive(pathname, item.href)}
                                    onNavigate={onNavigate}
                                />
                            </li>
                        ))}
                    </ul>
                </li>
            ))}
            {isAdmin && (
                <li className="mt-4">
                    <NavGroupHeading id="nav-group-admin">Admin</NavGroupHeading>
                    <ul role="list" aria-labelledby="nav-group-admin" className="space-y-0.5">
                        <li>
                            <NavItem
                                href="/admin"
                                icon={Shield}
                                label={edition.multiOrg ? 'Admin Dashboard' : 'Administration'}
                                current={pathname === '/admin'}
                                onNavigate={onNavigate}
                            />
                        </li>
                    </ul>
                </li>
            )}
            <li className="mt-auto pt-4">
                <ul role="list" className="space-y-0.5">
                    {/* "Send feedback" posts to the cloud's inbox; the community
                        edition's channel is Discussions, in the Help menu. */}
                    {demoMode ? <ScanYourClusterItem /> : edition.support ? <FeedbackItem /> : null}
                    <HelpItem support={edition.support} />
                </ul>
            </li>
            <li className="mt-2 border-t border-edge pt-2">
                {/* The person at the foot, the organization at the head: who is
                    looking, and at what. Theme, profile and sign out live inside. */}
                <UserMenu user={user} placement="top" onNavigate={onNavigate} />
            </li>
        </ul>
    );
}

export function Sidebar({
    sidebarOpen,
    setSidebarOpen,
    onOrganizationChange,
    userName,
    userImage,
    userEmail,
    isAdmin,
}: SidebarProps) {
    const pathname = usePathname();
    const user: UserMenuUser = { name: userName, email: userEmail, image: userImage };

    // Close mobile sidebar on navigation
    useEffect(() => {
        setSidebarOpen(false);
    }, [pathname, setSidebarOpen]);

    return (
        <>
            {/* Mobile sidebar dialog */}
            <Dialog open={sidebarOpen} onClose={setSidebarOpen} className="relative z-50 lg:hidden">
                <DialogBackdrop
                    transition
                    className="fixed inset-0 bg-backdrop transition-opacity duration-300 ease-linear data-closed:opacity-0"
                />
                <div className="fixed inset-0 flex">
                    <DialogPanel
                        transition
                        className="relative mr-16 flex w-full max-w-xs flex-1 transform transition duration-300 ease-in-out data-closed:-translate-x-full"
                    >
                        <TransitionChild>
                            <div className="absolute top-0 left-full flex w-16 justify-center pt-5 duration-300 ease-in-out data-closed:opacity-0">
                                <button
                                    type="button"
                                    onClick={() => setSidebarOpen(false)}
                                    className="-m-2.5 p-2.5 cursor-pointer"
                                >
                                    <span className="sr-only">Close sidebar</span>
                                    <X aria-hidden="true" className="size-6 text-on-emphasis" />
                                </button>
                            </div>
                        </TransitionChild>
                        {/* Floats over the backdrop rather than sitting in the page, so it
                            uses surface-overlay — see the elevation model in theme.css. */}
                        <div className="flex grow flex-col overflow-y-auto bg-surface-overlay px-3 pt-3 pb-4">
                            <nav aria-label="Main" className="flex flex-1 flex-col gap-y-1">
                                <NavItems user={user} onOrganizationChange={onOrganizationChange} isAdmin={isAdmin} />
                            </nav>
                        </div>
                    </DialogPanel>
                </div>
            </Dialog>

            {/* Desktop static sidebar */}
            <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-72 lg:flex-col">
                {/* `surface-raised`, not `surface-muted`: in light mode `surface-muted`
                    *is* the page canvas (both are Primer canvas-subtle — see the
                    surfaces note in theme.css), so the sidebar had only its border to
                    set it apart. Raised is white on the grey canvas in light and a step
                    up from it in dark: the sidebar is a pane, the same way cards are. */}
                <div className="flex grow flex-col overflow-y-auto border-r border-edge bg-surface-raised px-3 pt-3 pb-4">
                    <nav aria-label="Main" className="flex flex-1 flex-col gap-y-1">
                        <NavItems user={user} onOrganizationChange={onOrganizationChange} isAdmin={isAdmin} />
                    </nav>
                </div>
            </div>

            {/* Mobile top bar */}
            <div className="sticky top-0 z-40 flex items-center gap-x-4 bg-surface border-b border-edge px-4 py-3 sm:px-6 lg:hidden">
                <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="-m-2 p-2 text-ink-muted hover:text-ink-secondary lg:hidden cursor-pointer"
                >
                    <span className="sr-only">Open sidebar</span>
                    <Menu aria-hidden="true" className="size-5" />
                </button>
                <div className="ml-auto flex items-center gap-x-5">
                    {/* The palette, without opening the drawer. */}
                    <SearchTrigger variant="icon" />
                    {/* The same menu as the drawer's foot, reachable without opening
                        the drawer. It opens downward from here. */}
                    <UserMenu user={user} placement="bottom" />
                </div>
            </div>
        </>
    );
}
