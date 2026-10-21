import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Minimal query surface shared by `Pool` and `PoolClient`, so repositories can
 * run either inside or outside a transaction without changing their SQL.
 */
export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<Row>>;
}
