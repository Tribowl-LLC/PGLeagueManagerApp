import { describe, expect, it } from 'vitest';
import { analyzeOrganizationHostnameRows } from '../../scripts/audit-organization-hostname-collisions';

describe('organization hostname collision audit', () => {
  it('reports both cross-field directions with operator-safe identifiers', () => {
    const result = analyzeOrganizationHostnameRows([
      { organizationId: 10, slug: 'alpha', subdomain: 'sharedone' },
      { organizationId: 20, slug: 'sharedone', subdomain: 'bravo' },
      { organizationId: 30, slug: 'sharedtwo', subdomain: null },
      { organizationId: 40, slug: 'charlie', subdomain: 'sharedtwo' },
    ]);

    expect(result).toEqual({
      collisions: [
        {
          hostname: 'sharedone',
          organizations: [
            { organizationId: 10, sources: ['subdomain'] },
            { organizationId: 20, sources: ['slug'] },
          ],
        },
        {
          hostname: 'sharedtwo',
          organizations: [
            { organizationId: 30, sources: ['slug'] },
            { organizationId: 40, sources: ['subdomain'] },
          ],
        },
      ],
      nonLowercase: [],
    });
  });

  it('allows one organization to use the same value for slug and subdomain', () => {
    expect(analyzeOrganizationHostnameRows([
      { organizationId: 10, slug: 'samehost', subdomain: 'samehost' },
    ])).toEqual({ collisions: [], nonLowercase: [] });
  });

  it('normalizes case for collision detection and reports non-lowercase rows', () => {
    expect(analyzeOrganizationHostnameRows([
      { organizationId: 10, slug: 'MixedHost', subdomain: null },
      { organizationId: 20, slug: 'otherhost', subdomain: 'mixedhost' },
    ])).toEqual({
      collisions: [{
        hostname: 'mixedhost',
        organizations: [
          { organizationId: 10, sources: ['slug'] },
          { organizationId: 20, sources: ['subdomain'] },
        ],
      }],
      nonLowercase: [{
        organizationId: 10,
        source: 'slug',
        normalizedHostname: 'mixedhost',
      }],
    });
  });
});
