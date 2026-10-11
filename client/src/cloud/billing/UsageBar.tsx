// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { USAGE_WARNING_THRESHOLD } from '@/components/organization-settings/constants';

interface UsageBarProps {
    label: string;
    current: number;
    limit: number;
    warningThreshold?: number;
}

export function UsageBar({ label, current, limit, warningThreshold = USAGE_WARNING_THRESHOLD }: UsageBarProps) {
    const isUnlimited = limit === Infinity;
    const percentage = isUnlimited ? 0 : Math.min((current / limit) * 100, 100);
    const isWarning = !isUnlimited && current / limit >= warningThreshold;
    const isAtLimit = !isUnlimited && current >= limit;

    return (
        <div className="space-y-2">
            <div className="flex justify-between text-sm">
                <span className="text-ink-secondary">{label}</span>
                <span
                    className={`font-medium ${isAtLimit ? 'text-danger' : isWarning ? 'text-attention' : 'text-ink'}`}
                >
                    {current.toLocaleString()} / {isUnlimited ? '∞' : limit.toLocaleString()}
                </span>
            </div>
            <div className="h-2 bg-track rounded-full overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all ${
                        isAtLimit ? 'bg-danger-emphasis' : isWarning ? 'bg-attention-emphasis' : 'bg-accent-emphasis'
                    }`}
                    style={{ width: isUnlimited ? '0%' : `${percentage}%` }}
                />
            </div>
        </div>
    );
}
