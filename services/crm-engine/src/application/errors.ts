// Use-case errors with the stable codes of LLD §6; the HTTP adapter renders them as RFC 7807 problems.
export interface UseCaseFieldError {
  field: string;
  code: string;
  message?: string;
}

export class UseCaseError extends Error {
  override readonly name = 'UseCaseError';
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 412,
    readonly code: string,
    readonly detail?: string,
    readonly errors?: UseCaseFieldError[],
  ) {
    super(detail ?? code);
  }
}

export const notFoundError = (what: string) => new UseCaseError(404, 'not-found', `${what} not found`);
