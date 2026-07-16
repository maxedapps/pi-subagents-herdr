export const HERDR_PROTOCOL_VERSION = 16 as const;
export const MINIMUM_HERDR_VERSION = "0.7.3" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface HerdrRequest<TParams extends JsonValue = JsonValue> {
  readonly id: string;
  readonly method: string;
  readonly params: TParams;
}

export interface HerdrSuccess<TResult extends JsonValue = JsonValue> {
  readonly id: string;
  readonly result: TResult;
}

export interface HerdrErrorData {
  readonly code: string;
  readonly message: string;
  readonly data?: JsonValue;
}

export interface HerdrFailure {
  readonly id: string;
  readonly error: HerdrErrorData;
}

export type HerdrResponse<TResult extends JsonValue = JsonValue> = HerdrSuccess<TResult> | HerdrFailure;
