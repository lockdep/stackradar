'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button, LoadingBlock } from '@/components/ui';
import { useResource } from '@/hooks';
import { apiFetch, errorMessage } from '@/lib/api-client';
import { TIER_LENS_LABEL } from '@/lib/tier-lens';

/**
 * Findings views — how this organization's findings tables are split into
 * "Application" and "Base image", made the organization's own.
 *
 * Two things, neither of which is suppression: nothing here hides, excludes
 * or un-counts a finding, and exploited findings are shown under every view
 * regardless.
 *
 *  - **The default view.** Which view the tables (and the weekly digest's
 *    "Start here") open on when nothing else says. A reader's own last choice
 *    and a link's `?tier=` still win.
 *  - **Rules.** "Everything under `pkg:npm/@mycorp/` is our application."
 *    Applied after StackRadar's own rules. A change takes effect after a
 *    background pass over the organization's packages, so the counts here can
 *    lag a rule by a minute.
 */

/** The API's bucket words, mapped to what the reader sees. `main` is the application itself. */
type AssignableTier = 'application' | 'main' | 'os' | 'runtime';
type MatchKind = 'purl-prefix' | 'name' | 'path-prefix';

interface TierRule {
    id: string;
    matchKind: MatchKind;
    pattern: string;
    tier: AssignableTier;
    reason: string | null;
    createdByEmail: string | null;
    createdAt: string;
    componentsTouched: number;
}

const BUCKET_OF: Record<AssignableTier, 'application' | 'base'> = {
    application: 'application',
    main: 'application',
    os: 'base',
    runtime: 'base',
};

const MATCH_KIND_LABEL: Record<MatchKind, string> = {
    'purl-prefix': 'Package URL starts with',
    name: 'Package name is',
    'path-prefix': 'Path in the image starts with',
};

const MATCH_KIND_PLACEHOLDER: Record<MatchKind, string> = {
    'purl-prefix': 'pkg:npm/%40mycorp/',
    name: 'internal-sdk',
    'path-prefix': '/opt/vendor/',
};

export function FindingViewsTab({ orgId, canManage }: { orgId: string; canManage: boolean }) {
    const { data: defaultView, refetch: refetchDefault } = useResource<'application' | 'all'>(
        `/api/organizations/${orgId}`,
        {
            select: (body) =>
                (body as { organization?: { defaultFindingTier?: 'application' | 'all' } }).organization
                    ?.defaultFindingTier ?? 'application',
        },
    );
    const {
        data: rules,
        error: rulesError,
        refetch: refetchRules,
    } = useResource<TierRule[]>(canManage ? `/api/organizations/${orgId}/tier-rules` : null, {
        select: (body) => (body as { rules: TierRule[] }).rules,
        fallbackError: 'Could not load the rules',
    });

    const [matchKind, setMatchKind] = useState<MatchKind>('purl-prefix');
    const [pattern, setPattern] = useState('');
    const [bucket, setBucket] = useState<'application' | 'base'>('application');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const run = async (work: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        try {
            await work();
        } catch (err) {
            setError(errorMessage(err, 'Something went wrong'));
        } finally {
            setBusy(false);
        }
    };

    const saveDefault = (next: 'application' | 'all') =>
        run(async () => {
            await apiFetch(`/api/organizations/${orgId}`, { method: 'PATCH', json: { defaultFindingTier: next } });
            await refetchDefault();
        });

    const addRule = () =>
        run(async () => {
            await apiFetch(`/api/organizations/${orgId}/tier-rules`, {
                method: 'POST',
                /* A rule files a package under a view; the finer distinction
                   the classifier makes inside each view is not the org's to set. */
                json: {
                    matchKind,
                    pattern: pattern.trim(),
                    tier: bucket === 'application' ? 'application' : 'os',
                    reason: reason.trim() || null,
                },
            });
            setPattern('');
            setReason('');
            await refetchRules();
        });

    const removeRule = (id: string) =>
        run(async () => {
            await apiFetch(`/api/organizations/${orgId}/tier-rules/${id}`, { method: 'DELETE' });
            await refetchRules();
        });

    return (
        <div className="space-y-8">
            <section>
                <h2 className="text-base font-semibold text-ink">Default view</h2>
                <p className="mt-1 text-sm text-ink-muted">
                    The view findings tables open on, and what the weekly digest&apos;s &quot;Start here&quot; is drawn
                    from. Each person&apos;s own last choice, and a link that names a view, still win. Exploited
                    findings are shown under every view.
                </p>
                <div role="radiogroup" aria-label="Default findings view" className="mt-3 flex flex-wrap gap-4">
                    {(['application', 'all'] as const).map((value) => (
                        <label key={value} className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
                            <input
                                type="radio"
                                name="default-finding-view"
                                checked={defaultView === value}
                                disabled={!canManage || busy || defaultView === null}
                                onChange={() => void saveDefault(value)}
                                className="accent-accent-emphasis"
                            />
                            {TIER_LENS_LABEL[value]}
                            <span className="text-ink-muted">
                                {value === 'application' ? '— what your build added (recommended)' : '— every finding'}
                            </span>
                        </label>
                    ))}
                </div>
            </section>

            <section>
                <h2 className="text-base font-semibold text-ink">Rules</h2>
                <p className="mt-1 text-sm text-ink-muted">
                    Tell StackRadar which packages are yours. A rule files matching packages under Application or Base
                    image, after StackRadar&apos;s own rules. It never hides a finding or changes the Radar Score, and
                    it takes effect after a background pass over your packages.
                </p>

                {!canManage ? (
                    <p className="mt-3 text-sm text-ink-muted">Only owners and admins can see and change the rules.</p>
                ) : rulesError && !rules ? (
                    <p className="mt-3 text-sm text-ink-muted">{rulesError}</p>
                ) : !rules ? (
                    <LoadingBlock label="Loading rules..." className="py-8" />
                ) : (
                    <>
                        {rules.length === 0 ? (
                            <p className="mt-3 rounded-md border border-edge bg-surface-raised px-4 py-3 text-sm text-ink-muted">
                                No rules. StackRadar&apos;s own rules decide: operating-system packages and the tooling
                                that ships with the language are the base image&apos;s, everything else is yours.
                            </p>
                        ) : (
                            <ul className="mt-3 divide-y divide-edge rounded-md border border-edge bg-surface-raised">
                                {rules.map((rule) => (
                                    <li key={rule.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-sm text-ink">
                                                {MATCH_KIND_LABEL[rule.matchKind]}{' '}
                                                <code className="break-all font-mono text-xs">{rule.pattern}</code>
                                                {' → '}
                                                <strong>{TIER_LENS_LABEL[BUCKET_OF[rule.tier]]}</strong>
                                            </span>
                                            <span className="mt-0.5 block text-xs text-ink-muted">
                                                {rule.componentsTouched.toLocaleString()}{' '}
                                                {rule.componentsTouched === 1 ? 'package' : 'packages'} matched
                                                {rule.reason && <> · {rule.reason}</>}
                                                {rule.createdByEmail && <> · {rule.createdByEmail}</>}
                                            </span>
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => void removeRule(rule.id)}
                                            disabled={busy}
                                            aria-label={`Remove the rule for ${rule.pattern}`}
                                            className="shrink-0 cursor-pointer rounded-sm p-1 text-ink-muted hover:text-danger disabled:cursor-not-allowed"
                                        >
                                            <Trash2 aria-hidden="true" className="size-4" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}

                        <form
                            className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr_auto]"
                            onSubmit={(e) => {
                                e.preventDefault();
                                if (pattern.trim().length >= 3) void addRule();
                            }}
                        >
                            <select
                                aria-label="What the rule matches on"
                                value={matchKind}
                                onChange={(e) => setMatchKind(e.target.value as MatchKind)}
                                className="h-8 rounded-md border border-edge bg-btn-secondary px-2 text-sm text-ink"
                            >
                                {(Object.keys(MATCH_KIND_LABEL) as MatchKind[]).map((kind) => (
                                    <option key={kind} value={kind}>
                                        {MATCH_KIND_LABEL[kind]}
                                    </option>
                                ))}
                            </select>
                            <input
                                aria-label="Pattern"
                                value={pattern}
                                onChange={(e) => setPattern(e.target.value)}
                                placeholder={MATCH_KIND_PLACEHOLDER[matchKind]}
                                className="h-8 rounded-md border border-edge-strong px-2 font-mono text-sm text-ink outline-none focus:ring-4 focus:ring-edge"
                            />
                            <select
                                aria-label="Which view the packages belong under"
                                value={bucket}
                                onChange={(e) => setBucket(e.target.value as 'application' | 'base')}
                                className="h-8 rounded-md border border-edge bg-btn-secondary px-2 text-sm text-ink"
                            >
                                <option value="application">{TIER_LENS_LABEL.application}</option>
                                <option value="base">{TIER_LENS_LABEL.base}</option>
                            </select>
                            <input
                                aria-label="Reason (optional)"
                                value={reason}
                                onChange={(e) => setReason(e.target.value)}
                                placeholder="Why — for whoever reads this next (optional)"
                                className="h-8 rounded-md border border-edge-strong px-2 text-sm text-ink outline-none focus:ring-4 focus:ring-edge sm:col-span-2"
                            />
                            <Button variant="primary" type="submit" loading={busy} disabled={pattern.trim().length < 3}>
                                Add rule
                            </Button>
                        </form>
                        <p className="mt-2 text-xs text-ink-muted">
                            A pattern is compared literally — there are no wildcards — and needs at least three
                            characters. The most specific matching rule wins.
                        </p>
                    </>
                )}
                {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            </section>
        </div>
    );
}
