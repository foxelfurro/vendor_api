import express from 'express';
import { verifyToken, isAdmin } from './middlewares/auth.middleware';
import { login } from './controllers/auth.controller';
import { getSalesHistory, registerSale } from './controllers/sales.controller';
import { exploreCatalog, getInventory, addToInventory } from './controllers/vendor.controller';
import { getDashboardStats } from './controllers/dashboard.controller';
import cors from 'cors';
import { getMe } from './controllers/auth.controller';

// ...
const app = express();
app.use(cors()); // Esto permite que cualquier origen (como tu Vite) se conecte
app.use(express.json());

// ... resto de rutas y lógica del servidor
// Rutas Públicas
app.post('/auth/login', login);

// Rutas Admin (Aquí luego agregaremos tu endpoint de crear catálogo)
app.use('/admin', verifyToken, isAdmin);

// Rutas Vendedor
app.use('/vendor', verifyToken); // El middleware protege todo lo que empiece con /vendor
app.get('/vendor/explore', exploreCatalog);
app.get('/vendor/inventory', getInventory);
app.post('/vendor/inventory', addToInventory);

// Rutas Vendedor y Ventas
app.use('/vendor', verifyToken);
app.use('/sales', verifyToken);
app.post('/sales/register', registerSale);
app.get('/sales/history', verifyToken, getSalesHistory);
app.post('/vendor/sales', verifyToken, registerSale);
// Rutas Operaciones
app.post('/sales/register', verifyToken, registerSale);

app.get('/vendor/dashboard-stats', verifyToken, getDashboardStats);

// Ruta para obtener datos del usuario autenticado
app.get('/auth/me', verifyToken, getMe);

// Arrancar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en el puerto ${PORT}`));