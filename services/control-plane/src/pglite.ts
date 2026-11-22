import { PGlite } from "@electric-sql/pglite";

import type { Db } from "./db.ts";

/**
 * PGlite adapter: an in-process Postgres for tests and local development. PGlite has one connection,
 * so transactions are serialized here.
 */
export async function pgliteDb(dataDir?: string): Promise<Db & { close(): Promise<void> }> {
  const pg = await PGlite.create(dataDir);
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  // A multi-statement SQL string (a migration) has to go through exec; parameterized ones through query
  const run = async (sql: string, params?: unknown[]) => {
    if (!params?.length && sql.includes(";") && sql.trim().split(";").filter((s) => s.trim()).length > 1) {
      const results = await pg.exec(sql);
      return { rows: (results.at(-1)?.rows ?? []) as any[] };
    }
    const r = await pg.query(sql, params as any[]);
    return { rows: r.rows as any[] };
  };

  return {
    query: (sql, params) => serial(() => run(sql, params)) as any,
    exec: (sql) => serial(async () => void (await pg.exec(sql))),
    transaction: (fn) =>
      serial(() =>
        pg.transaction(async (tx) => {
          const q = async (sql: string, params?: unknown[]) => {
            if (!params?.length && sql.trim().split(";").filter((s) => s.trim()).length > 1) {
              const results = await tx.exec(sql);
              return { rows: (results.at(-1)?.rows ?? []) as any[] };
            }
            return { rows: (await tx.query(sql, params as any[])).rows as any[] };
          };
          return fn({ query: q as any });
        })
      ),
    close: () => pg.close(),
  };
}
