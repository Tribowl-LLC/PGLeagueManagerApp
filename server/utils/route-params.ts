/**
 * Return a route parameter only when Express parsed it as one scalar segment.
 *
 * Express 5 types wildcard parameters as `string[]`. These routes all use
 * named, single-segment parameters, so an array is malformed input and is
 * represented as an empty value for the existing validation paths to reject.
 */
export function singleRouteParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}
