interface HeaderResponse {
  setHeader(name: string, value: string): unknown;
}

/** Entry documents and service workers must always be revalidated per deploy. */
export function setStaticCacheHeaders(res: HeaderResponse, filePath: string): void {
  if (/(?:^|[\\/])(?:index\.html|sw\.js)$/.test(filePath)) {
    res.setHeader('Cache-Control', 'no-store');
  }
}
