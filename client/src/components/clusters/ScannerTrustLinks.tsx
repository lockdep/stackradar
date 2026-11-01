import { ExternalLink } from 'lucide-react';
import { SCANNER_TRUST_LINKS } from './scannerInstall';

/**
 * The three trust questions, as links, wherever the scanner is being
 * installed or looked at. Someone deciding whether to let an agent into a
 * cluster asks what leaves it, which ClusterRole it needs and what it costs
 * to run before they ask anything else; answering all three in one row, next
 * to the install command and on the cluster page, is cheaper than the
 * evaluator finding the docs on their own — or not.
 *
 * Each `<a>` is named by its text alone (the icon is `aria-hidden`), which
 * is what the end-to-end suite selects by.
 */
export function ScannerTrustLinks({
    variant = 'light',
    className = '',
}: {
    /** `dark` for the dark install surfaces; code blocks stay dark either way. */
    variant?: 'light' | 'dark';
    className?: string;
}) {
    const isDark = variant === 'dark';
    return (
        <nav
            aria-label="About the scanner"
            className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs ${isDark ? 'text-ink-faint' : 'text-ink-muted'} ${className}`}
        >
            {SCANNER_TRUST_LINKS.map((link) => (
                <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center gap-1 hover:underline ${isDark ? 'text-blue-400' : 'text-accent'}`}
                >
                    {link.label}
                    <ExternalLink aria-hidden="true" className="size-3" />
                </a>
            ))}
        </nav>
    );
}
