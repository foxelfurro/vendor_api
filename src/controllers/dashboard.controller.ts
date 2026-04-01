import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

export const getDashboardStats = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;

  try {
    // 1. Resumen general
    const summaryQuery = `
      SELECT 
        COALESCE(SUM(precio_total), 0) as total_ingresos,
        COALESCE(SUM(precio_total), 0) as valor_total_ventas,
        COALESCE(SUM(cantidad), 0) as unidades_vendidas,
        COUNT(id) as transacciones_totales
      FROM ventas 
      WHERE vendedor_id = $1;
    `;

    // 2. Alerta de stock bajo
    const lowStockQuery = `
      SELECT COUNT(*) as productos_criticos
      FROM inventario_vendedor
      WHERE vendedor_id = $1 AND stock < 5;
    `;

    // 3. Top 3 productos más vendidos
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

    // 4. Estadísticas de inventario
    const inventoryQuery = `
      SELECT 
        COALESCE(SUM(iv.stock), 0) as total_productos,
        COALESCE(SUM(iv.stock * iv.precio_personalizado), 0) as valor_total
      FROM inventario_vendedor iv
      WHERE iv.vendedor_id = $1;
    `;

    // 5. Últimas 5 ventas (para actividad reciente)
    const ultimasVentasQuery = `
      SELECT 
        v.id,
        v.cantidad,
        v.precio_total as total,
        TO_CHAR(v.fecha, 'DD/MM/YYYY HH24:MI') as fecha,
        cm.nombre as producto_nombre,
        cm.ruta_imagen as imagen
      FROM ventas v
      INNER JOIN inventario_vendedor iv ON v.inventario_id = iv.id
      INNER JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      WHERE v.vendedor_id = $1
      ORDER BY v.fecha DESC
      LIMIT 5;
    `;

    // 6. Datos para gráfica de los últimos 7 días
    const recentActivityQuery = `
      SELECT 
        TO_CHAR(fecha, 'DD Mon') as etiqueta,
        COALESCE(SUM(precio_total), 0) as total
      FROM ventas
      WHERE vendedor_id = $1 AND fecha >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY TO_CHAR(fecha, 'DD Mon'), DATE_TRUNC('day', fecha)
      ORDER BY DATE_TRUNC('day', fecha) ASC;
    `;

    // 7. Ventas mensuales del año actual
    const monthlyPerformanceQuery = `
      SELECT 
        TO_CHAR(fecha, 'Month') as mes,
        COALESCE(SUM(precio_total), 0) as total
      FROM ventas
      WHERE vendedor_id = $1 AND fecha >= DATE_TRUNC('year', CURRENT_DATE)
      GROUP BY TO_CHAR(fecha, 'Month'), DATE_TRUNC('month', fecha)
      ORDER BY DATE_TRUNC('month', fecha) ASC;
    `;

    // Ejecutar todas las consultas
    const [summary, lowStock, topProducts, inventory, ultimasVentas, recent, monthly] = await Promise.all([
      pool.query(summaryQuery, [vendorId]),
      pool.query(lowStockQuery, [vendorId]),
      pool.query(topProductsQuery, [vendorId]),
      pool.query(inventoryQuery, [vendorId]),
      pool.query(ultimasVentasQuery, [vendorId]),
      pool.query(recentActivityQuery, [vendorId]),
      pool.query(monthlyPerformanceQuery, [vendorId])
    ]);

    res.json({
      resumen: summary.rows[0],
      alertas: lowStock.rows[0],
      top_productos: topProducts.rows,
      inventario: inventory.rows[0],
      ultimas_ventas: ultimasVentas.rows,   // ← nuevo
      grafica_reciente: recent.rows,
      grafica_mensual: monthly.rows
    });

  } catch (error) {
    console.error("🔥 ERROR EN DASHBOARD STATS:", error);
    res.status(500).json({ error: 'No se pudieron generar las estadísticas.' });
  }
};