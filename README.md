# vendor-hub-api

API REST para **Qlatte Lumin** — plataforma SaaS de gestión de joyería para vendedoras.

Gestiona autenticación, catálogo maestro, inventarios por vendedora, ventas y pagos mediante el Checkout alojado de Conekta.

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Framework | Express 4 |
| Base de datos | PostgreSQL (Neon / Supabase) |
| Autenticación | JWT en cookie httpOnly |
| Pasarela de pagos | Conekta (Checkout alojado) |
| Correo transaccional | Resend |
| Captcha | Cloudflare Turnstile |
| Seguridad de contraseñas | bcrypt |

---

## Estructura del proyecto

```
src/
├── config/
│   ├── db.ts            # Pool de conexiones PostgreSQL
│   └── conekta.ts       # Cliente HTTP para la API de Conekta
├── controllers/
│   ├── auth.controller.ts       # Login, registro, recuperación de contraseña
│   ├── vendor.controller.ts     # Catálogo, inventario, tienda pública
│   ├── sales.controller.ts      # Registro e historial de ventas
│   ├── dashboard.controller.ts  # Estadísticas y KPIs del panel
│   ├── payments.controller.ts   # Checkout y webhook de Conekta
│   └── admin.controller.ts      # Gestión de usuarios y aprobaciones
├── middlewares/
│   └── auth.middleware.ts       # Verificación JWT + control de rol admin
├── lib/
│   └── conektaErrors.ts         # Mensajes amigables de errores de Conekta
└── index.ts                     # Punto de entrada, definición de rutas
```

---

## Instalación y configuración

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` y completa todos los valores. Consulta `.env.example` para la descripción detallada de cada variable.

### 3. Ejecutar en desarrollo

```bash
npm run dev
```

### 4. Compilar y ejecutar en producción

```bash
npm run build
npm start
```

---

## Endpoints principales

### Públicos (sin autenticación)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/login` | Inicio de sesión (requiere CAPTCHA Turnstile) |
| POST | `/auth/logout` | Cierre de sesión |
| POST | `/auth/register` | Registro de nueva cuenta |
| POST | `/auth/forgot-password` | Solicitar enlace de recuperación de contraseña |
| POST | `/auth/reset-password` | Restablecer contraseña con token |
| POST | `/payments/checkout` | Crear sesión de pago en Conekta |
| GET  | `/payments/estado/:pagoId` | Consultar estado de un pago |
| POST | `/webhooks/conekta/:secret` | Recibir eventos de Conekta |
| GET  | `/store/:slug` | Catálogo público de la tienda de una vendedora |

### Vendedor (requieren JWT)

| Método | Ruta | Descripción |
|---|---|---|
| GET    | `/auth/me` | Datos del usuario autenticado |
| GET    | `/vendor/explore` | Catálogo maestro disponible para agregar |
| GET    | `/vendor/inventory` | Inventario del vendedor |
| POST   | `/vendor/inventory` | Agregar joya del catálogo al inventario |
| POST   | `/vendor/inventory/custom` | Crear joya propia (pendiente de aprobación) |
| PUT    | `/vendor/inventory/:id` | Actualizar precio o stock de un ítem |
| DELETE | `/vendor/inventory/:id` | Eliminar ítem del inventario |
| GET    | `/vendor/dashboard-stats` | KPIs y estadísticas del panel de control |
| PUT    | `/vendor/store-settings` | Configurar tienda (slug, teléfono, personalización) |
| POST   | `/sales/register` | Registrar venta y descontar stock (transacción atómica) |
| GET    | `/sales/history` | Historial de ventas del vendedor |

### Administrador (requieren JWT + rol admin)

| Método | Ruta | Descripción |
|---|---|---|
| POST   | `/admin/users` | Crear usuario |
| POST   | `/admin/catalogo` | Agregar joya al catálogo maestro |
| GET    | `/admin/categorias` | Listar categorías disponibles |
| GET    | `/admin/catalogo/pendientes` | Joyas propias pendientes de aprobación |
| PUT    | `/admin/catalogo/:id` | Editar joya (SKU, categoría) |
| POST   | `/admin/catalogo/:id/aprobar` | Aprobar joya pendiente |
| DELETE | `/admin/catalogo/:id` | Rechazar o eliminar joya |

---

## Flujo de negocio

1. **Registro** — La cuenta se crea inactiva (`activo = false`, `suscripcion_estado = 'pendiente'`).
2. **Pago** — El Checkout alojado de Conekta activa la cuenta cuando el webhook confirma el pago.
3. **Catálogo maestro** — Joyas globales de la marca. Los admins las crean y aprueban; las vendedoras pueden proponer las suyas propias desde su inventario.
4. **Inventario** — Cada vendedora tiene su vitrina personal con precios personalizados.
5. **Ventas** — Se registran por ID de inventario; el stock se descuenta en transacción atómica para evitar inconsistencias.

---

## Variables de entorno requeridas

Consulta `.env.example` para la lista completa y documentada. Las mínimas para arrancar en desarrollo son:

- `DATABASE_URL`
- `JWT_SECRET`
- `CONEKTA_PRIVATE_KEY`
- `TURNSTILE_SECRET_KEY`
- `RESEND_API_KEY`
