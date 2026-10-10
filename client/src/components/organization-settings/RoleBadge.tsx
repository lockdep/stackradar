'use client'

import { Badge } from '@/components/ui'
import { roleVariants } from './constants'

export function RoleBadge({ role }: { role: string }) {
    const variant = roleVariants[role as keyof typeof roleVariants] ?? 'neutral'

    return (
        <Badge variant={variant} pill>
            {role.charAt(0).toUpperCase() + role.slice(1)}
        </Badge>
    )
}
