import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Response } from 'express';
import crypto from 'crypto';
import { r2, R2_BUCKET, R2_PUBLIC_URL } from '../config/r2';
import { AuthRequest } from '../middlewares/auth.middleware';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * POST /uploads/presigned-url
 *
 * Genera una URL prefirmada de R2 para que el frontend suba un archivo
 * directamente, sin pasar por el servidor. El servidor nunca toca los bytes
 * de la imagen: solo autoriza la subida y devuelve la URL pública final.
 *
 * Body:   { contentType: "image/jpeg", size: 123456 }
 * Returns { uploadUrl: "https://...", publicUrl: "https://..." }
 *
 * Flujo:
 *   1. Frontend llama a este endpoint → recibe { uploadUrl, publicUrl }
 *   2. Frontend hace PUT a uploadUrl con el archivo binario (no base64)
 *   3. Frontend envía publicUrl al endpoint de negocio que lo necesite
 */
export const getPresignedUploadUrl = async (req: AuthRequest, res: Response): Promise<any> => {
  const { contentType, size } = req.body;

  const ext = ALLOWED_TYPES[contentType as string];
  if (!ext) {
    return res.status(400).json({ error: 'Tipo de archivo no permitido. Solo JPEG, PNG o WebP.' });
  }

  const numSize = Number(size);
  if (!Number.isFinite(numSize) || numSize <= 0 || numSize > MAX_SIZE_BYTES) {
    return res.status(413).json({
      error: `El archivo no puede superar los ${MAX_SIZE_BYTES / 1024 / 1024} MB.`,
    });
  }

  const key = `uploads/${req.user!.user_id}/${crypto.randomUUID()}${ext}`;

  try {
    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: contentType as string,
      ContentLength: numSize,
    });

    const uploadUrl = await getSignedUrl(r2, command, { expiresIn: 300 });
    const publicUrl = `${R2_PUBLIC_URL}/${key}`;

    return res.json({ uploadUrl, publicUrl });
  } catch (error) {
    console.error('Error generando URL prefirmada de R2:', error);
    return res.status(500).json({ error: 'No se pudo generar la URL de subida.' });
  }
};
