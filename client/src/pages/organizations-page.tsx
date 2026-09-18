import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { Layout } from '@/components/layout';
import { PageLoadingState } from '@/components/page-states';

/**
 * Keep old bookmarks safe while removing the retired tenant-management UI.
 * The route remains guarded in App.tsx, so only the former system-admin
 * surface can reach this compatibility redirect.
 */
export default function OrganizationsPage() {
  const [, setLocation] = useLocation();

  useEffect(() => {
    setLocation('/business-settings');
  }, [setLocation]);

  return (
    <Layout>
      <PageLoadingState message="Opening Business Settings…" />
    </Layout>
  );
}
