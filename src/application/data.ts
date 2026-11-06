import type { Json } from "../../contracts/ports.js";
import { parseJson } from "../contracts/loader.js";
import { unwrap } from "../domain/errors.js";
export type ObjectValue = { [key: string]: Json };
export function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw { code: "INVALID_INPUT", message: "objectが必要です" };
  return value as ObjectValue;
}
export function text(value: unknown): string {
  if (typeof value !== "string")
    throw { code: "INVALID_INPUT", message: "文字列が必要です" };
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw { code: "INVALID_INPUT", message: "整数が必要です" };
  return value;
}
export function list(value: unknown): Json[] {
  if (!Array.isArray(value))
    throw { code: "INVALID_INPUT", message: "配列が必要です" };
  return value as Json[];
}
export const strings = (value: unknown): string[] => list(value).map(text);
export const decode = (value: string): Json => unwrap(parseJson(value));
export const record = (value: string): ObjectValue => object(decode(value));
export function requiredKeys(
  value: ObjectValue,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw { code: "INVALID_INPUT", message: `未知の入力項目: ${key}` };
}
