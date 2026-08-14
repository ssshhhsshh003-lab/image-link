export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
];

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ImageValidationResult {
  valid: boolean;
  error?: string;
}

export function validateDestinationUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  const trimmed = urlStr.trim();
  
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateImageMetadata(mimeType: string, sizeBytes: number): ImageValidationResult {
  if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType.toLowerCase())) {
    return {
      valid: false,
      error: 'Invalid image format. Allowed formats: JPEG, PNG, WebP, GIF.'
    };
  }

  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return {
      valid: false,
      error: 'Image file size exceeds maximum limit of 10 MB.'
    };
  }

  return { valid: true };
}

export function validateTitle(title?: string): boolean {
  if (!title) return true;
  return title.length <= 200;
}

export function validateDescription(description?: string): boolean {
  if (!description) return true;
  return description.length <= 500;
}

export const ALLOWED_IP_REDIRECT_LIMITS = [0, 1, 2, 3, 5, 10];

export function validateIpRedirectLimit(limit: any): boolean {
  if (typeof limit === 'string') {
    limit = parseInt(limit, 10);
  }
  return Number.isInteger(limit) && ALLOWED_IP_REDIRECT_LIMITS.includes(limit);
}

