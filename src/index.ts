import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { verifyToken, isAdmin } from './middlewares/auth.middleware';
import { login, logout, getMe, registerAccount, forgotPassword, resetPassword } from './controllers/auth.controller';
import { crearCheckout, estadoPago, webhookStripe, crearPortalAutenticado } from './controllers/payments.controller';
import { getSalesHistory, registerSale } from './controllers/sales.controller';
import { exploreCatalog, getInventory, addToInventory, updateInventoryItem, deleteInventoryItem, getSellerCatalogBySlug, updateStoreSettings, addCustomToInventory } from './controllers/vendor.controller';
import { getDashboardStats } from './controllers/dashboard.controller';
import { createUser, createCatalogItem, getCategorias, getPendingItems, updateCatalogItem, approveCatalogItem, rejectCatalogItem } from './controllers/admin.controller';
import { getPresignedUploadUrl } from './controllers/uploads.controller';

const app = express();

app.use(cookieParser());

app.use(cors({
  origin: ['https://lumin.qlatte.com', 'http://localhost:5173', 'https://api.qlatte.com', 'https://apidev.qlatte.com', 'https://clientdev.qlatte.com'],
  credentials: true,
}));

// Webhook de Stripe: necesita el body RAW para verificar la firma HMAC.
// Debe registrarse ANTES de express.json(), o la verificación fallará.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), webhookStripe);

// Las imágenes ya no pasan por el servidor (se suben directo a R2 vía presigned URL),
// así que el límite estándar de 1mb cubre todos los demás endpoints.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// ─── SUBIDA DE ARCHIVOS ──────────────────────────────────────────────────────
// Genera una URL prefirmada de R2. El frontend sube la imagen directamente
// a R2 con esa URL y luego envía la URL pública al endpoint que la necesite.
app.post('/uploads/presigned-url', verifyToken, getPresignedUploadUrl);

// ─── RUTAS PÚBLICAS ──────────────────────────────────────────────────────────
app.post('/auth/login', login);
app.post('/auth/logout', logout);
app.post('/auth/forgot-password', forgotPassword);
app.post('/auth/reset-password', resetPassword);
app.post('/auth/register', registerAccount);
app.get('/store/:slug', getSellerCatalogBySlug);

// ─── PAGOS (Stripe) ──────────────────────────────────────────────────────────
app.post('/payments/checkout', crearCheckout);
app.get('/payments/estado/:pagoId', estadoPago);
app.post('/payments/portal', verifyToken, crearPortalAutenticado);

// ─── ADMINISTRACIÓN ──────────────────────────────────────────────────────────
app.post('/admin/users', verifyToken, isAdmin, createUser);
app.post('/admin/catalogo', verifyToken, isAdmin, createCatalogItem);
app.get('/admin/categorias', verifyToken, isAdmin, getCategorias);
app.get('/admin/catalogo/pendientes', verifyToken, isAdmin, getPendingItems);
app.put('/admin/catalogo/:id', verifyToken, isAdmin, updateCatalogItem);
app.post('/admin/catalogo/:id/aprobar', verifyToken, isAdmin, approveCatalogItem);
app.delete('/admin/catalogo/:id', verifyToken, isAdmin, rejectCatalogItem);

// ─── VENDEDOR ────────────────────────────────────────────────────────────────
app.get('/vendor/explore', verifyToken, exploreCatalog);
app.get('/vendor/inventory', verifyToken, getInventory);
app.put('/vendor/inventory/:id', verifyToken, updateInventoryItem);
app.delete('/vendor/inventory/:id', verifyToken, deleteInventoryItem);
app.post('/vendor/inventory/custom', verifyToken, addCustomToInventory);
app.post('/vendor/inventory', verifyToken, addToInventory);
app.get('/vendor/dashboard-stats', verifyToken, getDashboardStats);
app.put('/vendor/store-settings', verifyToken, updateStoreSettings);

// ─── VENTAS ──────────────────────────────────────────────────────────────────
app.post('/sales/register', verifyToken, registerSale);
app.get('/sales/history', verifyToken, getSalesHistory);

// ─── PERFIL ──────────────────────────────────────────────────────────────────
app.get('/auth/me', verifyToken, getMe);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
