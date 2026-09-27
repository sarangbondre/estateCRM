// Type helpers over the generated contract types (@11e/contracts/<service>): the 2xx JSON body and request body of
// an operation, so cards stay in step with the contracts (CI fails on drift).
type JsonOf<R> = R extends { content: { 'application/json': infer B } } ? B : never;

export type Ok<Op> = Op extends { responses: infer R }
  ? R extends { 200: infer A }
    ? JsonOf<A>
    : R extends { 201: infer B }
      ? JsonOf<B>
      : R extends { 202: infer C }
        ? JsonOf<C>
        : never
  : never;

export type Body<Op> = Op extends { requestBody?: { content: infer C } }
  ? C extends { 'application/json': infer J }
    ? J
    : C extends { 'application/merge-patch+json': infer M }
      ? M
      : never
  : never;
