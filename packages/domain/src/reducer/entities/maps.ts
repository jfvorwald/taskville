// Immutable helpers for the ID-keyed maps in reducer state.
//
// State maps are plain objects so canonicalJson can hash them and the engine can store them as
// JSON. IDs come from producers, so any string is possible, including "__proto__" and
// "constructor". Reads go through Object.hasOwn (never `map[id]`, which would find
// Object.prototype members), and writes use object-literal computed keys, spread, and
// Object.fromEntries, all of which define own properties instead of invoking the
// __proto__ setter.

export type IdMap<T> = Readonly<Record<string, T>>;

export const getOwn = <T>(map: IdMap<T>, id: string): T | undefined =>
  Object.hasOwn(map, id) ? map[id] : undefined;

export const put = <T>(map: IdMap<T>, id: string, value: T): IdMap<T> => ({ ...map, [id]: value });

export const removeKeys = <T>(map: IdMap<T>, ids: ReadonlySet<string>): IdMap<T> =>
  ids.size === 0 ? map : Object.fromEntries(Object.entries(map).filter(([id]) => !ids.has(id)));

/** `list` with `items` appended, skipping any already present, in order. */
export function appendUnique(list: readonly string[], items: readonly string[]): string[] {
  const seen = new Set(list);
  const out = [...list];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** A copy of `obj` without `keys`. Only for fixed field names, never for IDs. */
export function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> {
  const out: Partial<T> = { ...obj };
  for (const key of keys) delete out[key];
  return out as Omit<T, K>;
}

/** `{ [key]: value }`, or `{}` when value is undefined, for spreading optional fields. */
export const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
