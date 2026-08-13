import { query, queryOne } from './database';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: Date;
}

export async function ensureUsersTableSchema(): Promise<void> {
  // Ensure users table exists with username and password_hash
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  // Migrate old schema if email exists without username/password_hash
  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='username') THEN
        ALTER TABLE users ADD COLUMN username VARCHAR(255) UNIQUE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password_hash') THEN
        ALTER TABLE users ADD COLUMN password_hash VARCHAR(255);
      END IF;
    END $$;
  `);

  // Initialize admin user if ADMIN_USERNAME & ADMIN_PASSWORD env vars are set and admin user does not exist
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  const existingAdmin = await queryOne<User>(
    'SELECT * FROM users WHERE username = $1 LIMIT 1',
    [adminUsername]
  );

  if (!existingAdmin) {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(adminPassword, salt);
    const userId = randomUUID();

    await query(
      'INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING',
      [userId, adminUsername, passwordHash]
    );
    console.log(`[AUTH INIT] Initialized admin user "${adminUsername}" in database.`);
  }
}

export async function authenticateUser(username: string, password: string): Promise<User | null> {
  await ensureUsersTableSchema();

  const user = await queryOne<User>(
    'SELECT * FROM users WHERE username = $1 LIMIT 1',
    [username]
  );

  if (!user || !user.password_hash) return null;

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return null;

  return user;
}

export function generateSessionToken(userId: string): string {
  const secret = process.env.AUTH_SECRET || 'default_auth_secret_key_change_in_prod';
  return jwt.sign({ userId }, secret, { expiresIn: '7d' });
}

export function verifySessionToken(token: string): { userId: string } | null {
  try {
    const secret = process.env.AUTH_SECRET || 'default_auth_secret_key_change_in_prod';
    const decoded = jwt.verify(token, secret) as { userId: string };
    return decoded;
  } catch {
    return null;
  }
}
