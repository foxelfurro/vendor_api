import express from 'express';
import cors from 'cors';
import { verifyToken, isAdmin } from './middlewares/auth.middleware';
import { login, getMe } from './controllers/auth.controller';
import { getSalesHistory, registerSale } from './controllers/sales.controller';
import { exploreCatalog, getInventory, addToInventory } from './controllers/vendor.controller';
import { getDashboardStats } from './controllers/dashboard.controller';
import { createUser, createCatalogItem } from './controllers/admin.controller';

const app = express();
app.use(cors());
app.use(express.json());

// --- RUTAS PÚBLICAS ---
app.post('/auth/login', login);

// --- RUTAS ADMIN ---
// Registro de usuarios
app.post('/admin/users', verifyToken, isAdmin, createUser);
app.post('/admin/catalogo', verifyToken, isAdmin, createCatalogItem);
// --- RUTAS VENDEDOR / OPERACIONES ---
app.get('/vendor/explore', verifyToken, exploreCatalog);
app.get('/vendor/inventory', verifyToken, getInventory);
app.post('/vendor/inventory', verifyToken, addToInventory);
app.get('/vendor/dashboard-stats', verifyToken, getDashboardStats);

app.post('/sales/register', verifyToken, registerSale);
app.get('/sales/history', verifyToken, getSalesHistory);

app.get('/auth/me', verifyToken, getMe);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
