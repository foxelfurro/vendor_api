import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser'; 

import { verifyToken, isAdmin } from './middlewares/auth.middleware';
import { login, logout, getMe, registerAccount, forgotPassword, resetPassword } from './controllers/auth.controller';
import { crearCheckout, estadoPago, webhookConekta } from './controllers/payments.controller';
import { getSalesHistory, registerSale } from './controllers/sales.controller';

// 1. IMPORTACIONES DEL VENDEDOR: Quitamos requestCatalogItem y agregamos addCustomToInventory
import { exploreCatalog, getInventory, addToInventory, updateInventoryItem, deleteInventoryItem, getSellerCatalogBySlug, updateStoreSettings, addCustomToInventory } from './controllers/vendor.controller';

import { getDashboardStats } from './controllers/dashboard.controller';
import { createUser, createCatalogItem, getCategorias, getPendingItems, updateCatalogItem, approveCatalogItem, rejectCatalogItem } from './controllers/admin.controller';


const app = express();


// Activamos el parseo de cookies primero
app.use(cookieParser());

// Configuramos el CORS
app.use(cors({
    origin: ['https://lumin.qlatte.com', 'http://localhost:5173','https://api.qlatte.com' ],
    credentials: true 
}));

// Aumentamos el límite para permitir que pasen las fotos en Base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- RUTAS PÚBLICAS (No requieren token) ---
app.post('/auth/login', login);
app.post('/auth/logout', logout);
app.post('/auth/forgot-password', forgotPassword);
app.post('/auth/reset-password', resetPassword);
app.post('/auth/register', registerAccount);
app.get('/store/:slug', getSellerCatalogBySlug);

// --- PAGOS (Conekta) ---
// Públicas: se identifican con correo + contraseña dentro del propio controlador.
app.post('/payments/checkout', crearCheckout);
app.get('/payments/estado/:pagoId', estadoPago);
// Webhook de Conekta. El secreto va en la URL configurada en el panel de Conekta.
app.post('/webhooks/conekta/:secret', webhookConekta);

// --- RUTAS PROTEGIDAS (Requieren verifyToken) ---

// Administración
app.post('/admin/users', verifyToken, isAdmin, createUser);
app.post('/admin/catalogo', verifyToken, isAdmin, createCatalogItem);
app.get('/admin/categorias', verifyToken, isAdmin, getCategorias);

// Aprobación de joyas propias creadas por vendedoras
app.get('/admin/catalogo/pendientes', verifyToken, isAdmin, getPendingItems);
app.put('/admin/catalogo/:id', verifyToken, isAdmin, updateCatalogItem);
app.post('/admin/catalogo/:id/aprobar', verifyToken, isAdmin, approveCatalogItem);
app.delete('/admin/catalogo/:id', verifyToken, isAdmin, rejectCatalogItem);

// Operaciones de Vendedor
app.get('/vendor/explore', verifyToken, exploreCatalog);
app.get('/vendor/inventory', verifyToken, getInventory);
// ACTUALIZADO: Maneja cambios de precio y stock
app.put('/vendor/inventory/:id', verifyToken, updateInventoryItem); 

// NUEVO: Elimina la joya de la vitrina
app.delete('/vendor/inventory/:id', verifyToken, deleteInventoryItem);
// 2. RUTA DE JOYA CUSTOM: La agregamos aquí
app.post('/vendor/inventory/custom', verifyToken, addCustomToInventory);

app.post('/vendor/inventory', verifyToken, addToInventory);
app.get('/vendor/dashboard-stats', verifyToken, getDashboardStats);
app.put('/vendor/store-settings', verifyToken, updateStoreSettings);

// Ventas y Registro
app.post('/sales/register', verifyToken, registerSale); 
app.get('/sales/history', verifyToken, getSalesHistory);

// Perfil y Autenticación
app.get('/auth/me', verifyToken, getMe);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SaaS corriendo en puerto ${PORT}`));
