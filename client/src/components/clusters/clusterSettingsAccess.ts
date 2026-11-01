import { isAdminOrOwner, type Organization } from '@/components/providers';

/**
 * What the cluster Settings tab is for the current viewer.
 *
 * - `manage`: an admin or owner outside the demo. Every control is live.
 * - `read-only`: the live demo. The demo visitor is drawn as a `member`
 *   (`viewerRole`), and a member would normally not see the tab at all —
 *   but an evaluator comparing scanners wants to see the scanner
 *   configuration surface (the key, the install command, the trust links)
 *   before installing anything, so the tab is shown with its fields disabled
 *   and no save, rotate or delete action. The server refuses every write on
 *   the demo org regardless (`read_only_demo`); this only decides what is
 *   drawn.
 * - `none`: a member outside the demo. The tab is not drawn and the route
 *   answers with a sentence, as before.
 *
 * One function for the tab strip and the page, so the two cannot disagree.
 */
type ClusterSettingsAccess = 'manage' | 'read-only' | 'none';

export function clusterSettingsAccess(organization: Organization | null, demoMode: boolean): ClusterSettingsAccess {
    if (demoMode) return 'read-only';
    return isAdminOrOwner(organization) ? 'manage' : 'none';
}
