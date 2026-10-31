// Reads from untrusted hook JSON. Only own properties count, so a key such as `toString` or
// `__proto__` never resolves to something inherited (L-18, L-29).

export type Json = Record<string, unknown>;

export const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const own = (record: unknown, key: string): unknown =>
  isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined;

export function ownString(record: unknown, key: string): string | undefined {
  const value = own(record, key);
  return typeof value === "string" ? value : undefined;
}
