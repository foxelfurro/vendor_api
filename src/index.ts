import express from 'express';
import cors from 'cors';
import { verifyToken, isAdmin } from './middlewares/auth.middleware';
// 1. Importamos la nueva función de suscripción
import { login, getMe, subscribeAndCreateAccount, forgotPassword, resetPassword, renewSubscription} from './controllers/auth.controller';
import { getSalesHistory, registerSale } from './controllers/sales.controller';
import { exploreCatalog, getInventory, addToInventory, updateInventoryStock } from './controllers/vendor.controller';
import { getDashboardStats } from './controllers/dashboard.controller';
import { createUser, createCatalogItem } from './controllers/admin.controller';


const app = express();
app.use(cors());
app.use(express.json());

// --- RUTAS PÚBLICAS (No requieren token) ---
app.post('/auth/login', login);
app.post('/auth/forgot-password', forgotPassword);
app.post('/auth/reset-password', resetPassword);
// Esta es la ruta que usará el Checkout para crear nuevos vendedores
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

