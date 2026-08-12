import { Pool } from 'pg';

// Singleton pool instance for serverless edge / node runtime reuse
let globalPool: Pool | null = null;

export function getDbPool(): Pool {
  if (!globalPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not defined.');
    }
    globalPool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return globalPool;
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const pool = getDbPool();
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}
