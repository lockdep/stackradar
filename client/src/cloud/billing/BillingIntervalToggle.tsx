// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { MAX_ANNUAL_SAVING_PCT, type BillingInterval } from './pricing';

interface BillingIntervalToggleProps {
    value: BillingInterval;
    onChange: (interval: BillingInterval) => void;
}

const OPTIONS: { value: BillingInterval; label: string; hint?: string }[] = [
    { value: 'month', label: 'Monthly' },
    { value: 'year', label: 'Annual', hint: `Save up to ${MAX_ANNUAL_SAVING_PCT}%` },
];

/**
 * Monthly / annual, as a segmented control. Annual is ten months' price on
 * both books, which the hint states as a saving — the cards show the amount.
 */
export function BillingIntervalToggle({ value, onChange }: BillingIntervalToggleProps) {
    return (
        <div
            role="radiogroup"
            aria-label="Billing interval"
            className="inline-flex rounded-md bg-surface-subtle p-0.5 ring-1 ring-edge"
        >
            {OPTIONS.map((option) => {
                const selected = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => onChange(option.value)}
                        className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                            selected ? 'bg-surface-raised text-ink shadow-resting' : 'text-ink-muted hover:text-ink'
                        }`}
                    >
                        {option.label}
                        {option.hint && (
                            <span className={`text-xs font-semibold ${selected ? 'text-accent' : 'text-ink-faint'}`}>
                                {option.hint}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
