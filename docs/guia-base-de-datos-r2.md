# Guía de migración de imágenes → Cloudflare R2 (Base de datos)

## Resumen

**No hay cambios de esquema requeridos.** Las columnas que almacenan imágenes (`ruta_imagen TEXT`, `personalizacion JSONB`) ya aceptan strings de URL sin modificación. La migración es puramente de datos, no de estructura.

El único trabajo requerido es limpiar los registros existentes que todavía tienen imágenes en Base64 (son pocos — solo los artículos custom subidos por vendedoras antes de esta migración) y migrarlos a R2.

---

## Columnas afectadas

| Tabla              | Columna          | Tipo   | Contenido actual                            |
|--------------------|------------------|--------|---------------------------------------------|
| `catalogo_maestro` | `ruta_imagen`    | TEXT   | URL del socio (4900+ filas) o Base64 (pocas filas de artículos custom) |
| `usuarios`         | `personalizacion`| JSONB  | Objeto con colores, slug, y posiblemente un campo `logo` en Base64 |

---

## Paso 1 — Identificar registros con Base64

Ejecuta estas queries para saber cuántos registros requieren migración:

```sql
-- Artículos custom con imagen en Base64
SELECT id, sku, nombre, creado_por,
       LEFT(ruta_imagen, 50) AS imagen_preview
FROM catalogo_maestro
WHERE ruta_imagen LIKE 'data:image%';

-- Tiendas con logo en Base64 dentro del JSONB
SELECT id, nombre, store_slug,
       personalizacion->>'logo' AS logo_preview
FROM usuarios
WHERE personalizacion->>'logo' LIKE 'data:image%';
```

---

## Paso 2 — Script de migración de `ruta_imagen`

Este script de Node.js lee cada fila con Base64, sube la imagen a R2 y actualiza la URL. Ejecútalo **una sola vez** con las variables de entorno de producción.

```typescript
// scripts/migrate-images-to-r2.ts
// Ejecutar: npx ts-node scripts/migrate-images-to-r2.ts

import { Pool } from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME!;
const PUBLIC_URL = process.env.R2_PUBLIC_URL!.replace(/\/$/, '');

async function uploadBase64ToR2(base64: string, folder: string): Promise<string> {
  // Formato esperado: "data:image/jpeg;base64,/9j/4AAQ..."
  const match = base64.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) throw new Error('Formato Base64 no reconocido.');

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const ext = mimeType.split('/')[1].replace('jpeg', 'jpg');
  const key = `${folder}/${crypto.randomUUID()}.${ext}`;

  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));

  return `${PUBLIC_URL}/${key}`;
}

async function migrateCatalogoMaestro() {
  const { rows } = await pool.query(
    `SELECT id, ruta_imagen FROM catalogo_maestro WHERE ruta_imagen LIKE 'data:image%'`
  );

  console.log(`Migrando ${rows.length} imágenes de catalogo_maestro...`);

  for (const row of rows) {
    try {
      const newUrl = await uploadBase64ToR2(row.ruta_imagen, 'migration/joyas');
      await pool.query(
        `UPDATE catalogo_maestro SET ruta_imagen = $1 WHERE id = $2`,
        [newUrl, row.id]
      );
      console.log(`  ✓ catalogo_maestro id=${row.id} → ${newUrl}`);
    } catch (err) {
      console.error(`  ✗ catalogo_maestro id=${row.id}:`, err);
    }
  }
}

async function migratePersonalizacion() {
  const { rows } = await pool.query(
    `SELECT id, personalizacion FROM usuarios WHERE personalizacion->>'logo' LIKE 'data:image%'`
  );

  console.log(`Migrando ${rows.length} logos de tiendas...`);

  for (const row of rows) {
    try {
      const logoBase64: string = row.personalizacion.logo;
      const newUrl = await uploadBase64ToR2(logoBase64, 'migration/logos');

      // Reemplazar solo el campo 'logo' dentro del JSONB existente
      await pool.query(
        `UPDATE usuarios
         SET personalizacion = personalizacion || jsonb_build_object('logo', $1::text)
         WHERE id = $2`,
        [newUrl, row.id]
      );
      console.log(`  ✓ usuarios id=${row.id} → ${newUrl}`);
    } catch (err) {
      console.error(`  ✗ usuarios id=${row.id}:`, err);
    }
  }
}

async function main() {
  try {
    await migrateCatalogoMaestro();
    await migratePersonalizacion();
    console.log('\nMigración completada.');
  } finally {
    await pool.end();
  }
}

main();
```

### Cómo ejecutarlo

```bash
# Con las variables de producción en .env:
npx ts-node scripts/migrate-images-to-r2.ts
```

---

## Paso 3 — Verificar que no quedaron registros con Base64

Después de ejecutar el script, confirma con:

```sql
-- Debe devolver 0 filas
SELECT COUNT(*) FROM catalogo_maestro WHERE ruta_imagen LIKE 'data:image%';

-- Debe devolver 0 filas
SELECT COUNT(*) FROM usuarios WHERE personalizacion->>'logo' LIKE 'data:image%';
```

---

## Configuración del bucket R2 en Cloudflare (responsabilidad del DBA / DevOps)

Estos pasos se hacen **una sola vez** en el panel de Cloudflare.

### 1. Crear el bucket

1. Panel de Cloudflare → R2 → **Create bucket**
2. Nombre sugerido: `qlatte-lumin-uploads`
3. Región: elegir la más cercana a los usuarios (América Latina → `enam` o `wnam`)

### 2. Habilitar acceso público

1. Entrar al bucket → **Settings** → **Public access**
2. Activar **Allow public access**
3. Opcionalmente conectar un dominio propio (ver siguiente punto)

### 3. Conectar dominio personalizado (recomendado)

En lugar de usar la URL por defecto de R2 (`*.r2.dev`), conecta `cdn.qlatte.com`:

1. En el bucket → **Settings** → **Custom domains** → **Connect domain**
2. Ingresar `cdn.qlatte.com`
3. Cloudflare agrega automáticamente el registro DNS (el dominio debe estar en Cloudflare)

### 4. Configurar CORS

**Obligatorio para que el frontend pueda hacer `PUT` directo desde el navegador.**

En el bucket → **Settings** → **CORS Policy**, agregar:

```json
[
  {
    "AllowedOrigins": [
      "https://lumin.qlatte.com",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "Content-Length"],
    "MaxAgeSeconds": 300
  }
]
```

### 5. Crear API token de R2

1. Panel de Cloudflare → R2 → **Manage R2 API tokens** → **Create API token**
2. Permisos: **Object Read & Write** (solo para el bucket `qlatte-lumin-uploads`)
3. Guardar el `Access Key ID` y `Secret Access Key`

### 6. Variables de entorno que el backend necesita

Agregar en el panel de Render.com (Environment → Environment Variables):

| Variable               | Ejemplo                                     | Descripción                              |
|------------------------|---------------------------------------------|------------------------------------------|
| `R2_ACCOUNT_ID`        | `a1b2c3d4e5f6...`                           | ID de la cuenta de Cloudflare            |
| `R2_ACCESS_KEY_ID`     | `abc123...`                                 | Del API token de R2                      |
| `R2_SECRET_ACCESS_KEY` | `xyz789...`                                 | Del API token de R2                      |
| `R2_BUCKET_NAME`       | `qlatte-lumin-uploads`                      | Nombre del bucket creado                 |
| `R2_PUBLIC_URL`        | `https://cdn.qlatte.com`                    | URL pública del bucket (con dominio propio) o `https://<bucket>.<accountId>.r2.dev` si no hay dominio propio |

> **El `R2_ACCOUNT_ID`** se encuentra en el panel de Cloudflare → R2 → lado derecho "Account ID".

---

## Checklist final

- [ ] Bucket creado en Cloudflare R2
- [ ] Acceso público habilitado
- [ ] Dominio personalizado `cdn.qlatte.com` conectado (opcional pero recomendado)
- [ ] Política CORS configurada con los orígenes correctos
- [ ] API token creado con permisos de lectura/escritura al bucket
- [ ] 5 variables de entorno agregadas en Render.com
- [ ] Script de migración ejecutado en producción
- [ ] Verificación SQL confirma 0 registros con Base64
- [ ] Frontend desplegado con los cambios de su guía
