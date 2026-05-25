# vendor-hub-api

API REST para **Qlatte Lumin** — plataforma SaaS de gestión de joyería para vendedoras.

Gestiona autenticación, catálogo maestro, inventarios por vendedora, ventas y pagos de suscripción mediante el Checkout alojado de Stripe.

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Framework | Express 5 |
| Base de datos | PostgreSQL (Neon / Supabase) |
| Autenticación | JWT en cookie httpOnly |
| Pasarela de pagos | Stripe (Checkout alojado + suscripciones) |
| Correo transaccional | Resend |
| Captcha | Cloudflare Turnstile |
| Seguridad de contraseñas | bcrypt |

---

## Estructura del proyecto

```
src/
├── config/
│   ├── db.ts            # Pool de conexiones PostgreSQL
│   └── stripe.ts        # Cliente del SDK de Stripe (apiVersion fijada)
├── controllers/
│   ├── auth.controller.ts       # Login, registro, recuperación de contraseña
│   ├── vendor.controller.ts     # Catálogo, inventario, tienda pública
│   ├── sales.controller.ts      # Registro e historial de ventas
│   ├── dashboard.controller.ts  # Estadísticas y KPIs del panel
│   ├── payments.controller.ts   # Checkout y webhook de Stripe
│   └── admin.controller.ts      # Gestión de usuarios y aprobaciones
├── middlewares/
│   └── auth.middleware.ts       # Verificación JWT + control de rol admin
├── lib/
│   └── stripeErrors.ts          # Mensajes amigables de errores de Stripe
└── index.ts                     # Punto de entrada, definición de rutas

migrations/                      # Scripts SQL de migración (orden cronológico)
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
| POST | `/payments/checkout` | Iniciar el pago: devuelve la URL del Checkout (suscripción nueva) o del Billing Portal (si ya existe suscripción) |
| GET  | `/payments/estado/:pagoId` | Consultar estado de un pago |
| POST | `/webhooks/stripe` | Recibir eventos de Stripe (firma HMAC) |
| GET  | `/store/:slug` | Catálogo público de la tienda de una vendedora |

### Vendedor (requieren JWT)

| Método | Ruta | Descripción |
|---|---|---|
| GET    | `/auth/me` | Datos del usuario autenticado |
| POST   | `/payments/portal` | Abrir el Billing Portal de Stripe para gestionar la suscripción |
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

1. **Registro** — La cuenta se crea con `suscripcion_estado = 'pendiente'` (sin acceso hasta completar el pago).
2. **Pago** — `POST /payments/checkout` crea una sesión de Checkout de Stripe en modo `subscription`. La persona paga en la página segura de Stripe y, cuando el webhook (`invoice.payment_succeeded`) confirma el cobro, la cuenta se activa y se fija la vigencia de la suscripción.
3. **Renovación** — Stripe cobra la suscripción cada mes de forma automática; cada cobro dispara un nuevo `invoice.payment_succeeded` que extiende `suscripcion_fin`. Los cobros fallidos marcan la cuenta como `pago_fallido`.
4. **Gestión de la suscripción** — Quien ya tiene una suscripción usa el **Billing Portal** de Stripe para actualizar su método de pago, ver facturas, cancelar o reanudar. El aviso de renovación de la app abre el portal con `POST /payments/portal`; y `POST /payments/checkout` redirige también al portal si detecta una suscripción existente, en vez de crear una duplicada.
5. **Catálogo maestro** — Joyas globales de la marca. Los admins las crean y aprueban; las vendedoras pueden proponer las suyas propias desde su inventario.
6. **Inventario** — Cada vendedora tiene su vitrina personal con precios personalizados.
7. **Ventas** — Se registran por ID de inventario; el stock se descuenta en transacción atómica para evitar inconsistencias.

### Webhook de Stripe

El endpoint `POST /webhooks/stripe` se registra **antes** de `express.json()` porque necesita el cuerpo crudo (`Buffer`) para verificar la firma HMAC. Eventos procesados: `checkout.session.completed`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.updated` y `customer.subscription.deleted`.

### Billing Portal

El Billing Portal (gestión de la suscripción) debe habilitarse una vez en el panel de Stripe: **Settings → Billing → Customer portal**. Sin esa configuración activada, `POST /payments/portal` y la redirección al portal desde `POST /payments/checkout` fallan. No requiere variables de entorno adicionales.

---

## Variables de entorno requeridas

Consulta `.env.example` para la lista completa y documentada. Las mínimas para arrancar en desarrollo son:

- `DATABASE_URL`
- `JWT_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`
- `TURNSTILE_SECRET_KEY`
- `RESEND_API_KEY`
