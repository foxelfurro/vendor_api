import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser'; // 1. Importación hasta arriba

import { verifyToken, isAdmin } from './middlewares/auth.middleware';
// 2. Importamos la función de logout aquí
import { login, logout, getMe, subscribeAndCreateAccount, forgotPassword, resetPassword, renewSubscription} from './controllers/auth.controller';
import { getSalesHistory, registerSale } from './controllers/sales.controller';
import { exploreCatalog, getInventory, addToInventory, updateInventoryStock } from './controllers/vendor.controller';
import { getDashboardStats } from './controllers/dashboard.controller';
import { createUser, createCatalogItem } from './controllers/admin.controller';

const app = express();



// 3. Activamos el parseo de cookies primero
app.use(cookieParser());

// 4. Configuramos el CORS una sola vez con el dominio base
app.use(cors({
    origin: ['https://lumin.qlatte.com', 'http://localhost:5173'],
    credentials: true 
}));

app.use(express.json());

// --- RUTAS PÚBLICAS (No requieren token) ---
app.post('/auth/login', login);
app.post('/auth/logout', logout); // <-- Añadimos la ruta de logout aquí
app.post('/auth/forgot-password', forgotPassword);
app.post('/auth/reset-password', resetPassword);
app.post('/auth/subscribe', subscribeAndCreateAccount); 

// --- RUTAS PROTEGIDAS (Requieren verifyToken) ---

// Administración
app.post('/admin/users', verifyToken, isAdmin, createUser);
app.post('/admin/catalogo', verifyToken, isAdmin, createCatalogItem);

// Operaciones de Vendedor
app.get('/vendor/explore', verifyToken, exploreCatalog);
app.get('/vendor/inventory', verifyToken, getInventory);
app.post('/vendor/inventory', verifyToken, addToInventory);
app.put('/vendor/inventory/:id', verifyToken, updateInventoryStock);
app.get('/vendor/dashboard-stats', verifyToken, getDashboardStats);

// Ventas y Registro
app.post('/sales/register', verifyToken, registerSale); // Venta local
app.get('/sales/history', verifyToken, getSalesHistory);

// Perfil y Autenticación
app.get('/auth/me', verifyToken, getMe);

// RUTA DE RENOVACIÓN 
app.post('/auth/renew', renewSubscription);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SaaS corriendo en puerto ${PORT}`));