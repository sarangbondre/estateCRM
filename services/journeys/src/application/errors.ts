// Business rule violations raised by use cases; the HTTP adapter renders them as RFC 7807 with the LLD §6 codes.
export class JourneyError extends Error {
  override readonly name = 'JourneyError';
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 410 | 412 | 503,
    readonly code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export const notFoundErr = (what = 'resource') => new JourneyError(404, 'not-found', `${what} not found`);
export const invalidTransition = (detail: string) => new JourneyError(409, 'invalid-transition', detail);
export const versionMismatchErr = () => new JourneyError(412, 'version-mismatch');
export const forbiddenErr = (detail: string) => new JourneyError(403, 'forbidden', detail);
export const notOwnerErr = (detail: string) => new JourneyError(403, 'not-owner', detail);
export const outsideLaunchArea = () =>
  new JourneyError(409, 'outside-launch-area', 'the subject is outside the launch area (Z-7)');
