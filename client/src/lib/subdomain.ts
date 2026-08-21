const MAIN_DOMAIN = 'leaguevault.app';

export function getSubdomainSlug(): string | null {
  const hostname = window.location.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    const params = new URLSearchParams(window.location.search);
    return params.get('__org_slug') || null;
  }

  if (hostname === MAIN_DOMAIN || hostname === `www.${MAIN_DOMAIN}`) {
    return null;
  }

  if (hostname.endsWith(`.${MAIN_DOMAIN}`)) {
    const sub = hostname.slice(0, -(MAIN_DOMAIN.length + 1));
    if (!sub || sub.includes('.')) return null;
    const ignored = new Set(['www', 'api', 'admin', 'mail']);
    if (ignored.has(sub)) return null;
    return sub;
  }

  return null;
}
