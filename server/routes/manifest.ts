import { Router, Request, Response } from 'express';
import { appEnv } from '../config';
import { commitSha } from '../utils/build-info';
import { createLogger } from '../logger';

const log = createLogger("Manifest");
const router = Router();

const DEFAULT_MANIFEST = {
  name: "LeagueVault",
  short_name: "LeagueVault",
  description: "Bowling League Management",
  start_url: "/",
  display: "standalone" as const,
  background_color: "#ffffff",
  theme_color: "#1a1f36",
  orientation: "any" as const,
  icons: [
    { src: "/icons/icon-72x72.png", sizes: "72x72", type: "image/png" },
    { src: "/icons/icon-96x96.png", sizes: "96x96", type: "image/png" },
    { src: "/icons/icon-128x128.png", sizes: "128x128", type: "image/png" },
    { src: "/icons/icon-144x144.png", sizes: "144x144", type: "image/png" },
    { src: "/icons/icon-192x192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icons/icon-384x384.png", sizes: "384x384", type: "image/png" },
    { src: "/icons/icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

router.get('/manifest.json', (req: Request, res: Response) => {
  const org = req.subdomainOrg;

  if (!org) {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.json(DEFAULT_MANIFEST);
  }

  const icons = [];
  if (org.appIcon || org.logo) {
    const iconUrl = `/api/organizations/slug/${org.slug}/app-icon`;
    icons.push(
      { src: iconUrl, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: iconUrl, sizes: "512x512", type: "image/png", purpose: "any" },
    );
  } else {
    icons.push(...DEFAULT_MANIFEST.icons);
  }

  const manifest = {
    name: "LeagueVault",
    short_name: "LeagueVault",
    description: "Bowling League Management",
    start_url: "/bowler-dashboard",
    display: "standalone" as const,
    background_color: "#ffffff",
    theme_color: "#1a1f36",
    orientation: "any" as const,
    icons,
  };

  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(manifest);
});

router.get('/api/org-context', (req: Request, res: Response) => {
  const org = req.subdomainOrg;

  // `appEnv` and `commit` ride along here (instead of `/api/health`) so
  // deployment verification can reuse an existing endpoint without giving
  // anonymous callers a dedicated fingerprinting endpoint. Surfaced at the top level
  // (alongside `data`) so consumers that already destructure `data`
  // for the org payload keep working unchanged.
  const envelope = {
    success: true as const,
    appEnv,
    commit: commitSha,
  };

  if (!org) {
    return res.json({ ...envelope, data: null });
  }

  res.json({
    ...envelope,
    data: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo,
      darkLogo: org.darkLogo,
      appIcon: org.appIcon,
    },
  });
});

export default router;
