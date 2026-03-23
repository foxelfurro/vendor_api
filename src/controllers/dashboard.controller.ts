import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

export const getDashboardStats = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;

  try {
    // 1. Resumen general (Ventas totales y cantidad de productos vendidos)
    // Se agregó 'valor_total_ventas' devolviendo el mismo cálculo de ingresos, 
    // por si en el futuro decides separarlo (ej. ingresos netos vs brutos).
    const summaryQuery = `
      SELECT 
        COALESCE(SUM(precio_total), 0) as total_ingresos,
        COALESCE(SUM(precio_total), 0) as valor_total_ventas,
        COALESCE(SUM(cantidad), 0) as unidades_vendidas,
        COUNT(id) as transacciones_totales
      FROM ventas 
      WHERE vendedor_id = $1;
    `;

    // 2. Alerta de Stock Bajo (Productos con menos de 5 unidades)
    const lowStockQuery = `
      SELECT COUNT(*) as productos_criticos
      FROM inventario_vendedor
      WHERE vendedor_id = $1 AND stock < 5;
    `;

    // 3. Top 3 Productos más vendidos
    const topProductsQuery = `
      SELECT 
        cm.nombre,
        SUM(v.cantidad) as total_vendido
      FROM ventas v
      INNER JOIN inventario_vendedor iv ON v.inventario_id = iv.id
      INNER JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      WHERE v.vendedor_id = $1
      GROUP BY cm.nombre
      ORDER BY total_vendido DESC
      LIMIT 3;
    `;

    // 4. NUEVO: Estadísticas de Inventario (Total de productos y Valor monetario del stock)
    // Calcula la suma de todo el stock y el valor multiplicando stock * precio.
    const inventoryQuery = `
      SELECT 
        COALESCE(SUM(iv.stock), 0) as total_productos,
        COALESCE(SUM(iv.stock * iv.precio_personalizado), 0) as valor_total
      FROM inventario_vendedor iv
      INNER JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      WHERE iv.vendedor_id = $1;
    `;

    // Ejecutamos todas las consultas al mismo tiempo para mayor velocidad
    const [summary, lowStock, topProducts, inventory] = await Promise.all([
      pool.query(summaryQuery, [vendorId]),
      pool.query(lowStockQuery, [vendorId]),
      pool.query(topProductsQuery, [vendorId]),
      pool.query(inventoryQuery, [vendorId]) // <-- Añadido al Promise.all
    ]);

    res.json({
      resumen: summary.rows[0],
      alertas: lowStock.rows[0],
      top_productos: topProducts.rows,
      inventario: inventory.rows[0] // <-- Nuevo objeto enviado al frontend
    });

  } catch (error) {
    console.error("🔥 ERROR EN DASHBOARD STATS:", error);
    res.status(500).json({ error: 'No se pudieron generar las estadísticas.' });
  }
};