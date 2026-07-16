export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly severity: "info" | "warning" | "error";
}

export type Result<T, E = Diagnostic> =
  | { readonly ok: true; readonly value: T; readonly diagnostics?: readonly Diagnostic[] }
  | { readonly ok: false; readonly error: E; readonly diagnostics?: readonly Diagnostic[] };

export function ok<T>(value: T, diagnostics?: readonly Diagnostic[]): Result<T> {
  return diagnostics === undefined ? { ok: true, value } : { ok: true, value, diagnostics };
}

export function err<E>(error: E, diagnostics?: readonly Diagnostic[]): Result<never, E> {
  return diagnostics === undefined ? { ok: false, error } : { ok: false, error, diagnostics };
}
