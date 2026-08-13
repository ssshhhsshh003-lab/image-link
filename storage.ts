import { put, del } from '@vercel/blob';

export async function uploadImageToStorage(fileBuffer: Buffer | Blob, fileName: string, contentType: string): Promise<string> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  console.log(`[STORAGE DIAGNOSTIC] File: ${fileName}, size: ${Buffer.isBuffer(fileBuffer) ? fileBuffer.length : 'blob'}, mime: ${contentType}`);
  console.log(`[STORAGE DIAGNOSTIC] BLOB_TOKEN_PRESENT=${Boolean(token)}, tokenLength=${token ? token.length : 0}`);

  if (!token) {
    console.error('[STORAGE DIAGNOSTIC ERROR] BLOB_READ_WRITE_TOKEN environment variable is missing or empty.');
    throw new Error('BLOB_READ_WRITE_TOKEN environment variable is not defined.');
  }

  try {
    const blob = await put(fileName, fileBuffer, {
      access: 'public',
      contentType,
      token,
    });
    console.log(`[STORAGE DIAGNOSTIC SUCCESS] Uploaded blob URL: ${blob.url}`);
    return blob.url;
  } catch (err: any) {
    console.error('[STORAGE DIAGNOSTIC ERROR] Vercel Blob put failed:', {
      name: err?.name,
      message: err?.message,
      code: err?.code,
      status: err?.status || err?.statusCode,
      cause: err?.cause ? String(err.cause) : undefined,
    });
    throw err;
  }
}

export async function deleteImageFromStorage(imageUrl: string): Promise<void> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token || !imageUrl) return;

  try {
    await del(imageUrl, { token });
  } catch (err) {
    console.error('Failed to delete blob storage image:', err);
  }
}
