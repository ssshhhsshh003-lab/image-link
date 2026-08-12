import { put, del } from '@vercel/blob';

export async function uploadImageToStorage(fileBuffer: Buffer | Blob, fileName: string, contentType: string): Promise<string> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN environment variable is not defined.');
  }

  const blob = await put(fileName, fileBuffer, {
    access: 'public',
    contentType,
    token,
  });

  return blob.url;
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
