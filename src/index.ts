import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser'; 

import { verifyToken, isAdmin } from './middlewares/auth.middleware';
import { login, logout, getMe, subscribeAndCreateAccount, forgotPassword, resetPassword, renewSubscription} from './controllers/auth.controller';
import { getSalesHistory, registerSale } from './controllers/sales.controller';

// 1. IMPORTACIONES DEL VENDEDOR: Quitamos requestCatalogItem y agregamos addCustomToInventory
import { exploreCatalog, getInventory, addToInventory, updateInventoryItem, deleteInventoryItem, getSellerCatalogBySlug, updateStoreSettings, addCustomToInventory } from './controllers/vendor.controller';

import { getDashboardStats } from './controllers/dashboard.controller';
import { createUser, createCatalogItem } from './controllers/admin.controller';


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
app.post('/auth/subscribe', subscribeAndCreateAccount); 
app.get('/store/:slug', getSellerCatalogBySlug);

// --- RUTAS PROTEGIDAS (Requieren verifyToken) ---

// Administración
app.post('/admin/users', verifyToken, isAdmin, createUser);
app.post('/admin/catalogo', verifyToken, isAdmin, createCatalogItem);

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

// RUTA DE RENOVACIÓN 
app.post('/auth/renew', renewSubscription);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SaaS corriendo en puerto ${PORT}`));
