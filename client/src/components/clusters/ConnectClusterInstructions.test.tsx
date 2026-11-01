import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeConfigProvider } from '@/components/providers/RuntimeConfigProvider';
import { resolveEdition } from '@/lib/edition';
import { ConnectClusterInstructions } from './ConnectClusterInstructions';
import { SCANNER_TRUST_LINKS } from './scannerInstall';

/**
 * The install instructions carry the three trust links — what the scanner
 * sends, which ClusterRole it needs, its Helm values — so an evaluator reads
 * them next to the command they are about. Asserted as the `href`s, which
 * are the contract with the docs site's heading ids.
 */
const render = (variant: 'light' | 'dark') =>
    renderToStaticMarkup(
        <RuntimeConfigProvider
            config={{
                scannerChartVersion: '0.7.0',
                publicApiUrl: null,
                demoMode: false,
                edition: resolveEdition('cloud'),
                localLogin: false,
            }}
        >
            <ConnectClusterInstructions clusterId="c1" clusterName="platform-eu1" apiKey={null} variant={variant} />
        </RuntimeConfigProvider>,
    );

describe('ConnectClusterInstructions', () => {
    it('links the three trust pages under the install command', () => {
        const html = render('light');
        expect(html).toContain('href="https://stackradar.io/docs/architecture#data-leaving"');
        expect(html).toContain('href="https://stackradar.io/docs/architecture#permissions"');
        expect(html).toContain('href="https://stackradar.io/docs/helm-values"');
        expect(html).toContain('What the scanner sends');
        expect(html).toContain('Permissions it needs');
        expect(html).toContain('Helm values');
    });

    it('renders every link in SCANNER_TRUST_LINKS, on both variants', () => {
        for (const variant of ['light', 'dark'] as const) {
            const html = render(variant);
            for (const link of SCANNER_TRUST_LINKS) {
                expect(html).toContain(`href="${link.href}"`);
                expect(html).toContain(`${link.label}<`);
            }
        }
    });
});
