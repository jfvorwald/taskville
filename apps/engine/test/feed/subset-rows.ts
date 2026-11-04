import { StatementSync } from "node:sqlite";
import { vi } from "vitest";

// Counts event rows read through SQLite statements (shared by the M5.14 index tests). Wraps
// `StatementSync.prototype` iterate, all and get for statements that read event envelopes, so it
// holds for any index design and any storage method name. Work is counted, never timed (L-206).

const reads = (sql: string): boolean => /envelope_json|\bfrom\s+events\b/i.test(sql);

/** Counts event rows read through the SQLite statements while `during` runs. */
export async function countRows(during: () => Promise<void>): Promise<number> {
  let rows = 0;
  const proto = StatementSync.prototype;
  const iterate = proto.iterate;
  const all = proto.all;
  const get = proto.get;
  const spies = [
    vi.spyOn(proto, "iterate").mockImplementation(function (this: StatementSync, ...args) {
      const it = iterate.apply(this, args as never) as Iterable<unknown>;
      if (!reads(this.sourceSQL)) return it as never;
      return (function* () {
        for (const row of it) {
          rows++;
          yield row;
        }
      })() as never;
    }),
    vi.spyOn(proto, "all").mockImplementation(function (this: StatementSync, ...args) {
      const out = all.apply(this, args as never);
      if (reads(this.sourceSQL)) rows += out.length;
      return out;
    }),
    vi.spyOn(proto, "get").mockImplementation(function (this: StatementSync, ...args) {
      const out = get.apply(this, args as never);
      if (out !== undefined && reads(this.sourceSQL)) rows++;
      return out;
    }),
  ];
  try {
    await during();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return rows;
}
