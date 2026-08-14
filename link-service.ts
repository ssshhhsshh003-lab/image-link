import { query, queryOne, getDbPool } from './database';
import { uploadImageToStorage, deleteImageFromStorage } from './storage';
import { generateSlug } from './slug';
import {
  validateDestinationUrl,
  validateImageMetadata,
  validateTitle,
  validateDescription,
  validateIpRedirectLimit
} from './validation';
import { randomUUID, createHmac } from 'crypto';

export interface ImageLink {
  id: string;
  userId: string;
  slug: string;
  imageUrl: string;
  title: string | null;
  description: string | null;
  destinationUrl: string;
  totalClicks: number;
  ipRedirectLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicImageLink {
  id: string;
  slug: string;
  imageUrl: string;
  title: string | null;
  description: string | null;
  destinationUrl: string;
  ipRedirectLimit: number;
}

export interface CountryStat {
  id: string;
  imageLinkId: string;
  countryCode: string;
  countryName: string;
  clicks: number;
}

export interface CreateImageLinkInput {
  userId: string;
  imageBuffer: Buffer;
  imageFileName: string;
  mimeType: string;
  destinationUrl: string;
  title?: string;
  description?: string;
  ipRedirectLimit?: number;
}

// Automatically ensure table schemas and column alterations exist
let schemaEnsured = false;
export async function ensureIpLimitSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    // 1. Add ip_redirect_limit column if missing
    await query(`
      ALTER TABLE image_links 
      ADD COLUMN IF NOT EXISTS ip_redirect_limit INT DEFAULT 2 NOT NULL;
    `);
    
    // 2. Create ip_redirect_usage table if missing
    await query(`
      CREATE TABLE IF NOT EXISTS ip_redirect_usage (
        id VARCHAR(64) PRIMARY KEY,
        image_link_id VARCHAR(64) NOT NULL REFERENCES image_links(id) ON DELETE CASCADE,
        ip_hash VARCHAR(128) NOT NULL,
        redirect_count INT DEFAULT 0 NOT NULL,
        window_started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        CONSTRAINT unique_link_ip_hash UNIQUE (image_link_id, ip_hash)
      );
    `);

    // 3. Create index for fast lookups
    await query(`
      CREATE INDEX IF NOT EXISTS idx_ip_redirect_usage_link_ip ON ip_redirect_usage(image_link_id, ip_hash);
    `);

    schemaEnsured = true;
  } catch (err) {
    console.error('ensureIpLimitSchema error:', err);
  }
}

// One-way salt/hash visitor IP address safely
export function hashIpAddress(ip: string): string {
  const secret = process.env.AUTH_SECRET || process.env.DATABASE_URL || 'simple_image_links_salt_2026';
  // Normalize IPv4-mapped IPv6 addresses e.g. ::ffff:127.0.0.1 -> 127.0.0.1
  let normalized = (ip || '127.0.0.1').trim().toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.substring(7);
  }
  return createHmac('sha256', secret).update(normalized).digest('hex');
}

// Ensure unique slug with collision checks
async function generateUniqueSlug(): Promise<string> {
  let attempts = 0;
  while (attempts < 10) {
    const slug = generateSlug(9);
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM image_links WHERE slug = $1 LIMIT 1',
      [slug]
    );
    if (!existing) return slug;
    attempts++;
  }
  throw new Error('SLUG_COLLISION: Failed to generate a unique link slug');
}

export async function createImageLink(input: CreateImageLinkInput): Promise<ImageLink> {
  await ensureIpLimitSchema();
  const { userId, imageBuffer, imageFileName, mimeType, destinationUrl, title, description } = input;
  const ipRedirectLimit = input.ipRedirectLimit !== undefined ? Number(input.ipRedirectLimit) : 2;

  if (!validateDestinationUrl(destinationUrl)) {
    throw new Error('INVALID_DESTINATION_URL');
  }

  const imageCheck = validateImageMetadata(mimeType, imageBuffer.length);
  if (!imageCheck.valid) {
    throw new Error(imageCheck.error || 'INVALID_IMAGE');
  }

  if (!validateTitle(title)) {
    throw new Error('TITLE_TOO_LONG');
  }

  if (!validateDescription(description)) {
    throw new Error('DESCRIPTION_TOO_LONG');
  }

  if (!validateIpRedirectLimit(ipRedirectLimit)) {
    throw new Error('INVALID_IP_REDIRECT_LIMIT');
  }

  // 1. Upload image to Vercel Blob
  let imageUrl: string;
  try {
    imageUrl = await uploadImageToStorage(imageBuffer, imageFileName, mimeType);
  } catch (err: any) {
    console.error('createImageLink Blob storage upload failed:', err);
    throw new Error(`STORAGE_ERROR: ${err?.message || 'Vercel Blob upload failed'}`);
  }

  // 2. Generate slug & save in DB with cleanup fallback
  try {
    const slug = await generateUniqueSlug();
    const id = randomUUID();
    const now = new Date();

    const row = await queryOne<any>(
      `INSERT INTO image_links (
        id, user_id, slug, image_url, title, description, destination_url, total_clicks, ip_redirect_limit, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10)
      RETURNING id, user_id as "userId", slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", total_clicks as "totalClicks", ip_redirect_limit as "ipRedirectLimit", created_at as "createdAt", updated_at as "updatedAt"`,
      [id, userId, slug, imageUrl, title || null, description || null, destinationUrl, ipRedirectLimit, now, now]
    );

    if (!row) throw new Error('DATABASE_ERROR');
    return row as ImageLink;
  } catch (err) {
    // Attempt cleanup of orphaned blob image if DB insertion failed
    await deleteImageFromStorage(imageUrl);
    throw err;
  }
}

export async function getImageLinkBySlug(slug: string): Promise<PublicImageLink | null> {
  await ensureIpLimitSchema();
  const row = await queryOne<any>(
    `SELECT id, slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", COALESCE(ip_redirect_limit, 2) as "ipRedirectLimit"
     FROM image_links
     WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return row || null;
}

export async function getImageLinkById(linkId: string, userId: string): Promise<ImageLink | null> {
  await ensureIpLimitSchema();
  const row = await queryOne<any>(
    `SELECT id, user_id as "userId", slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", total_clicks as "totalClicks", COALESCE(ip_redirect_limit, 2) as "ipRedirectLimit", created_at as "createdAt", updated_at as "updatedAt"
     FROM image_links
     WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [linkId, userId]
  );
  return row || null;
}

export async function getUserImageLinks(userId: string): Promise<ImageLink[]> {
  await ensureIpLimitSchema();
  const rows = await query<any>(
    `SELECT id, user_id as "userId", slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", total_clicks as "totalClicks", COALESCE(ip_redirect_limit, 2) as "ipRedirectLimit", created_at as "createdAt", updated_at as "updatedAt"
     FROM image_links
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows as ImageLink[];
}

// Atomic increment for total clicks
export async function incrementTotalClicks(linkId: string): Promise<void> {
  await query(
    `UPDATE image_links 
     SET total_clicks = total_clicks + 1, updated_at = NOW()
     WHERE id = $1`,
    [linkId]
  );
}

// Atomic upsert for country clicks
export async function incrementCountryClicks(
  linkId: string,
  countryCode: string,
  countryName: string
): Promise<void> {
  const code = (countryCode || 'XX').toUpperCase();
  const name = countryName || 'Unknown';
  const id = randomUUID();
  const now = new Date();

  await query(
    `INSERT INTO country_stats (id, image_link_id, country_code, country_name, clicks, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $5)
     ON CONFLICT (image_link_id, country_code)
     DO UPDATE SET 
       clicks = country_stats.clicks + 1,
       country_name = EXCLUDED.country_name,
       updated_at = NOW()`,
    [id, linkId, code, name, now]
  );
}

// Atomic Check & Increment per-IP Redirect Limit using a PostgreSQL Transaction with FOR UPDATE lock
export async function checkAndIncrementIpRedirectLimit(
  linkId: string,
  ipHash: string,
  limit: number
): Promise<{ allowed: boolean }> {
  // 0 means Unlimited redirects
  if (limit === 0) {
    return { allowed: true };
  }

  await ensureIpLimitSchema();
  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const now = new Date();
    const usageId = randomUUID();

    // Lock existing row or prepare to insert
    const selectRes = await client.query<any>(
      `SELECT id, redirect_count as "redirectCount", window_started_at as "windowStartedAt"
       FROM ip_redirect_usage
       WHERE image_link_id = $1 AND ip_hash = $2
       FOR UPDATE`,
      [linkId, ipHash]
    );

    let usage = selectRes.rows[0];

    if (!usage) {
      // Upsert brand new usage record safely
      const insertRes = await client.query<any>(
        `INSERT INTO ip_redirect_usage (id, image_link_id, ip_hash, redirect_count, window_started_at, updated_at)
         VALUES ($1, $2, $3, 1, $4, $4)
         ON CONFLICT (image_link_id, ip_hash)
         DO UPDATE SET updated_at = NOW()
         RETURNING id, redirect_count as "redirectCount", window_started_at as "windowStartedAt"`,
        [usageId, linkId, ipHash, now]
      );
      usage = insertRes.rows[0];
      await client.query('COMMIT');
      return { allowed: true };
    }

    // Check if 24 hours (86400 seconds) have elapsed since window_started_at
    const windowStart = new Date(usage.windowStartedAt).getTime();
    const elapsedMs = now.getTime() - windowStart;
    const isWindowExpired = elapsedMs >= 24 * 60 * 60 * 1000;

    if (isWindowExpired) {
      // Reset window and set redirect_count to 1
      await client.query(
        `UPDATE ip_redirect_usage
         SET redirect_count = 1, window_started_at = $1, updated_at = $1
         WHERE id = $2`,
        [now, usage.id]
      );
      await client.query('COMMIT');
      return { allowed: true };
    }

    // Window active: check limit
    if (usage.redirectCount >= limit) {
      await client.query('COMMIT');
      return { allowed: false };
    }

    // Increment count atomically within active window
    await client.query(
      `UPDATE ip_redirect_usage
       SET redirect_count = redirect_count + 1, updated_at = $1
       WHERE id = $2`,
      [now, usage.id]
    );

    await client.query('COMMIT');
    return { allowed: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('checkAndIncrementIpRedirectLimit transaction error:', err);
    // On unexpected DB error, allow request to avoid blocking users
    return { allowed: true };
  } finally {
    client.release();
  }
}

export async function getCountryStatsForLink(linkId: string, userId: string): Promise<CountryStat[]> {
  // First verify user ownership
  const link = await getImageLinkById(linkId, userId);
  if (!link) {
    throw new Error('UNAUTHORIZED');
  }

  const rows = await query<any>(
    `SELECT id, image_link_id as "imageLinkId", country_code as "countryCode", country_name as "countryName", clicks
     FROM country_stats
     WHERE image_link_id = $1
     ORDER BY clicks DESC`,
    [linkId]
  );
  return rows as CountryStat[];
}

export async function updateImageLink(
  linkId: string,
  userId: string,
  updates: {
    title?: string;
    description?: string;
    destinationUrl?: string;
    ipRedirectLimit?: number;
    newImageBuffer?: Buffer;
    newImageFileName?: string;
    newMimeType?: string;
  }
): Promise<ImageLink> {
  const existing = await getImageLinkById(linkId, userId);
  if (!existing) {
    throw new Error('UNAUTHORIZED');
  }

  let finalImageUrl = existing.imageUrl;
  let oldImageUrlToDelete: string | null = null;

  if (updates.newImageBuffer && updates.newImageFileName && updates.newMimeType) {
    const imageCheck = validateImageMetadata(updates.newMimeType, updates.newImageBuffer.length);
    if (!imageCheck.valid) {
      throw new Error(imageCheck.error || 'INVALID_IMAGE');
    }
    oldImageUrlToDelete = existing.imageUrl;
    finalImageUrl = await uploadImageToStorage(
      updates.newImageBuffer,
      updates.newImageFileName,
      updates.newMimeType
    );
  }

  if (updates.destinationUrl && !validateDestinationUrl(updates.destinationUrl)) {
    throw new Error('INVALID_DESTINATION_URL');
  }

  if (updates.ipRedirectLimit !== undefined && !validateIpRedirectLimit(updates.ipRedirectLimit)) {
    throw new Error('INVALID_IP_REDIRECT_LIMIT');
  }

  const title = updates.title !== undefined ? updates.title : existing.title;
  const description = updates.description !== undefined ? updates.description : existing.description;
  const destinationUrl = updates.destinationUrl || existing.destinationUrl;
  const ipRedirectLimit = updates.ipRedirectLimit !== undefined ? Number(updates.ipRedirectLimit) : existing.ipRedirectLimit;

  const row = await queryOne<any>(
    `UPDATE image_links
     SET title = $1, description = $2, destination_url = $3, image_url = $4, ip_redirect_limit = $5, updated_at = NOW()
     WHERE id = $6 AND user_id = $7
     RETURNING id, user_id as "userId", slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", total_clicks as "totalClicks", ip_redirect_limit as "ipRedirectLimit", created_at as "createdAt", updated_at as "updatedAt"`,
    [title, description, destinationUrl, finalImageUrl, ipRedirectLimit, linkId, userId]
  );

  if (oldImageUrlToDelete && oldImageUrlToDelete !== finalImageUrl) {
    await deleteImageFromStorage(oldImageUrlToDelete);
  }

  return row as ImageLink;
}

export async function deleteImageLink(linkId: string, userId: string): Promise<void> {
  const existing = await getImageLinkById(linkId, userId);
  if (!existing) {
    throw new Error('UNAUTHORIZED');
  }

  // Delete DB record (country_stats and ip_redirect_usage will CASCADE delete automatically)
  await query('DELETE FROM image_links WHERE id = $1 AND user_id = $2', [linkId, userId]);

  // Delete blob storage file after successful DB delete
  await deleteImageFromStorage(existing.imageUrl);
}

