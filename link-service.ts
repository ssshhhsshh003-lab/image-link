import { query, queryOne } from './database';
import { uploadImageToStorage, deleteImageFromStorage } from './storage';
import { generateSlug } from './slug';
import {
  validateDestinationUrl,
  validateImageMetadata,
  validateTitle,
  validateDescription
} from './validation';
import { randomUUID } from 'crypto';

export interface ImageLink {
  id: string;
  userId: string;
  slug: string;
  imageUrl: string;
  title: string | null;
  description: string | null;
  destinationUrl: string;
  totalClicks: number;
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
  const { userId, imageBuffer, imageFileName, mimeType, destinationUrl, title, description } = input;

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
        id, user_id, slug, image_url, title, description, destination_url, total_clicks, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9)
      RETURNING id, user_id as "userId", slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", total_clicks as "totalClicks", created_at as "createdAt", updated_at as "updatedAt"`,
      [id, userId, slug, imageUrl, title || null, description || null, destinationUrl, now, now]
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
  const row = await queryOne<any>(
    `SELECT id, slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl"
     FROM image_links
     WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return row || null;
}

export async function getImageLinkById(linkId: string, userId: string): Promise<ImageLink | null> {
  const row = await queryOne<any>(
    `SELECT id, user_id as "userId", slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", total_clicks as "totalClicks", created_at as "createdAt", updated_at as "updatedAt"
     FROM image_links
     WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [linkId, userId]
  );
  return row || null;
}

export async function getUserImageLinks(userId: string): Promise<ImageLink[]> {
  const rows = await query<any>(
    `SELECT id, user_id as "userId", slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", total_clicks as "totalClicks", created_at as "createdAt", updated_at as "updatedAt"
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

  const title = updates.title !== undefined ? updates.title : existing.title;
  const description = updates.description !== undefined ? updates.description : existing.description;
  const destinationUrl = updates.destinationUrl || existing.destinationUrl;

  const row = await queryOne<any>(
    `UPDATE image_links
     SET title = $1, description = $2, destination_url = $3, image_url = $4, updated_at = NOW()
     WHERE id = $5 AND user_id = $6
     RETURNING id, user_id as "userId", slug, image_url as "imageUrl", title, description, destination_url as "destinationUrl", total_clicks as "totalClicks", created_at as "createdAt", updated_at as "updatedAt"`,
    [title, description, destinationUrl, finalImageUrl, linkId, userId]
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

  // Delete DB record (country_stats will CASCADE delete automatically)
  await query('DELETE FROM image_links WHERE id = $1 AND user_id = $2', [linkId, userId]);

  // Delete blob storage file after successful DB delete
  await deleteImageFromStorage(existing.imageUrl);
}
