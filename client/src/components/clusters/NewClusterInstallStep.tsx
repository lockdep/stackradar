'use client'

import type { Cluster } from '@/types/cluster'
import { ConnectClusterInstructions } from './ConnectClusterInstructions'

/** Step 3: point the scanner at the new cluster. */
export function NewClusterInstallStep({ cluster, apiKey }: { cluster: Cluster; apiKey: string }) {
    return (
        <ConnectClusterInstructions
            clusterId={cluster.id}
            clusterName={cluster.name}
            apiKey={apiKey}
            variant="light"
        />
    )
}
