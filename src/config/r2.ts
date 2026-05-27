import { S3Client } from '@aws-sdk/client-s3';

const required = (name: string): string => {
  const val = process.env[name];
  if (!val) throw new Error(`Falta la variable de entorno ${name}.`);
  return val;
};

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
  },
});

export const R2_BUCKET = required('R2_BUCKET_NAME');
export const R2_PUBLIC_URL = required('R2_PUBLIC_URL').replace(/\/$/, '');
