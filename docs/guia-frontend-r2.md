# Guía de migración de imágenes → Cloudflare R2 (Frontend)

## ¿Qué cambió y por qué?

Antes, los formularios que permitían subir imágenes las codificaban en Base64 y las enviaban directamente al servidor dentro del JSON del request. Eso hacía que cada subida de imagen reservara hasta 50MB en la RAM del servidor, y era la causa directa de los crasheos por falta de memoria en producción.

**Nuevo flujo:** el servidor nunca toca los bytes de la imagen. El frontend obtiene una URL autorizada de corta duración (URL prefirmada) y sube el archivo directamente a Cloudflare R2 desde el navegador. Al servidor solo le llega la URL pública resultante.

```
Antes:  Frontend ──[imagen en Base64, ~50MB]──► API ──► DB
Ahora:  Frontend ──[pide permiso]────────────► API
        Frontend ──[archivo binario]──────────► R2 (Cloudflare)
        Frontend ──[URL pública]──────────────► API ──► DB
```

---

## Nuevo endpoint: `POST /uploads/presigned-url`

**Requiere token de sesión.**

### Request
```json
{
  "contentType": "image/jpeg",
  "size": 1048576
}
```

| Campo         | Tipo     | Descripción                                           |
|---------------|----------|-------------------------------------------------------|
| `contentType` | `string` | Tipo MIME del archivo. Solo `image/jpeg`, `image/png`, `image/webp`. |
| `size`        | `number` | Tamaño en bytes del archivo (`file.size` en el navegador). Máximo 5 MB (5 242 880 bytes). |

### Response
```json
{
  "uploadUrl": "https://<account>.r2.cloudflarestorage.com/...",
  "publicUrl": "https://cdn.qlatte.com/uploads/<userId>/<uuid>.jpg"
}
```

| Campo       | Descripción                                                                 |
|-------------|-----------------------------------------------------------------------------|
| `uploadUrl` | URL prefirmada de R2. Hacer un `PUT` con el archivo binario. Expira en 5 min. |
| `publicUrl` | URL pública permanente. Esta es la que se guarda en la base de datos.       |

---

## Helper reutilizable (TypeScript/JavaScript)

Copia esta función en un archivo de utilidades (ej. `src/lib/uploadImage.ts`):

```typescript
/**
 * Sube un archivo de imagen a Cloudflare R2 en dos pasos:
 * 1. Obtiene una URL prefirmada del servidor.
 * 2. Sube el archivo directamente a R2.
 *
 * @returns La URL pública permanente del archivo subido.
 */
export async function uploadImage(file: File): Promise<string> {
  // Validación en cliente (el servidor también valida, esto solo mejora UX)
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

  if (!ALLOWED.includes(file.type)) {
    throw new Error('Solo se permiten imágenes JPEG, PNG o WebP.');
  }
  if (file.size > MAX_SIZE) {
    throw new Error('La imagen no puede superar los 5 MB.');
  }

  // Paso 1: obtener URL prefirmada
  const res = await fetch('/uploads/presigned-url', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentType: file.type, size: file.size }),
  });

  if (!res.ok) {
    const { error } = await res.json();
    throw new Error(error || 'No se pudo obtener la URL de subida.');
  }

  const { uploadUrl, publicUrl } = await res.json();

  // Paso 2: subir el archivo directamente a R2
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file, // archivo binario, NO base64
  });

  if (!upload.ok) {
    throw new Error('Error al subir el archivo a almacenamiento.');
  }

  return publicUrl;
}
```

---

## Formularios afectados y cambios requeridos

### 1. Joya propia del vendedor — `POST /vendor/inventory/custom`

**Campo que cambia:** `imagen_custom` (Base64) → `imagen_url` (URL string)

**Antes:**
```typescript
const base64 = await fileToBase64(file); // ← eliminar
const body = {
  nombre, sku, stock, precio_personalizado,
  imagen_custom: base64, // ← eliminar
};
await fetch('/vendor/inventory/custom', { method: 'POST', body: JSON.stringify(body) });
```

**Después:**
```typescript
import { uploadImage } from '@/lib/uploadImage';

// Subir la imagen primero (solo si el usuario eligió una)
const imagen_url = file ? await uploadImage(file) : undefined;

const body = {
  nombre, sku, stock, precio_personalizado,
  imagen_url, // ← URL de R2 o undefined
};
await fetch('/vendor/inventory/custom', { method: 'POST', body: JSON.stringify(body) });
```

**Patrón de UI recomendado:**
```typescript
const handleSubmit = async () => {
  setLoading(true);
  try {
    let imagen_url: string | undefined;
    if (selectedFile) {
      setStatus('Subiendo imagen...');
      imagen_url = await uploadImage(selectedFile);
    }
    setStatus('Guardando joya...');
    await crearJoyaCustom({ nombre, sku, stock, precio_personalizado, imagen_url });
  } catch (err) {
    setError(err.message);
  } finally {
    setLoading(false);
  }
};
```

---

### 2. Catálogo maestro (Admin) — `POST /admin/catalogo` y `PUT /admin/catalogo/:id`

**Campo que cambia:** `ruta_imagen` antes podía ser Base64, ahora debe ser una URL.

**Antes:**
```typescript
const base64 = await fileToBase64(file);
const body = { sku, nombre, descripcion, precio_sugerido, ruta_imagen: base64, ... };
```

**Después:**
```typescript
import { uploadImage } from '@/lib/uploadImage';

const ruta_imagen = file ? await uploadImage(file) : existingUrl;
const body = { sku, nombre, descripcion, precio_sugerido, ruta_imagen, ... };
```

---

### 3. Configuración de tienda — `PUT /vendor/store-settings`

**El campo `personalizacion`** es un objeto JSONB libre. Si contenía imágenes en Base64 (ej. un logo), ahora esas imágenes deben subirse a R2 primero.

**Antes:**
```typescript
const logoBase64 = await fileToBase64(logoFile);
const personalizacion = {
  color_primario: '#ff5733',
  logo: logoBase64, // ← eliminar
};
```

**Después:**
```typescript
import { uploadImage } from '@/lib/uploadImage';

const logoUrl = logoFile ? await uploadImage(logoFile) : personalizacion.logo;
const personalizacion = {
  color_primario: '#ff5733',
  logo: logoUrl, // ← URL de R2
};
```

---

## Input de archivo recomendado

Para consistencia en todos los formularios afectados:

```tsx
function ImagePicker({ onFileChange }: { onFileChange: (file: File | null) => void }) {
  return (
    <input
      type="file"
      accept="image/jpeg,image/png,image/webp"
      onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
    />
  );
}
```

No usar `FileReader.readAsDataURL()` en ningún formulario de subida. El helper `uploadImage` recibe el objeto `File` directamente.

---

## Respuestas de error del endpoint `/uploads/presigned-url`

| HTTP | Significado                                  | Acción sugerida                       |
|------|----------------------------------------------|---------------------------------------|
| 400  | Tipo de archivo no permitido                 | Mostrar error al usuario              |
| 401  | Sin sesión                                   | Redirigir a login                     |
| 413  | Archivo demasiado grande (> 5 MB)            | Mostrar error al usuario              |
| 500  | Error interno al contactar R2               | Reintentar o mostrar error genérico   |

---

## Variables de entorno (no cambian en el frontend)

El frontend sigue usando la misma `VITE_API_URL` de siempre. No necesita saber nada de R2.
