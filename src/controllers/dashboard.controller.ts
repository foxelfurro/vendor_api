/**
 * @file dashboard.controller.ts
 * @description Controlador de estadísticas del panel de control del vendedor.
 *
 * Ejecuta múltiples consultas en paralelo para construir el payload de
 * métricas que consume el componente Dashboard del frontend.
 *
 * Endpoint que maneja (requiere token válido):
 *  - GET /vendor/dashboard-stats → KPIs, últimas ventas, gráficas y alertas.
 */

import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

export const getDashboardStats = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;

  try {
    // 1. Resumen general
    // Los casts (::float8 / ::int) son importantes: sin ellos pg devuelve los
    // agregados numeric/bigint como STRING, y el frontend (toLocaleString,
    // gráficas) los necesita como número.
    const summaryQuery = `
      SELECT
        COALESCE(SUM(precio_total), 0)::float8 as total_ingresos,
        COALESCE(SUM(precio_total), 0)::float8 as valor_total_ventas,
        COALESCE(SUM(cantidad), 0)::int as unidades_vendidas,
        COUNT(id)::int as transacciones_totales,
        COALESCE(SUM(CASE WHEN DATE(fecha) = CURRENT_DATE THEN cantidad ELSE 0 END), 0)::int as joyas_vendidas_hoy,
        COALESCE(SUM(CASE WHEN DATE(fecha) = CURRENT_DATE THEN precio_total ELSE 0 END), 0)::float8 as ingresos_hoy
      FROM ventas
      WHERE vendedor_id = $1;
    `;

    // 2. Alerta de stock bajo
    const lowStockQuery = `
      SELECT COUNT(*)::int as productos_criticos
      FROM inventario_vendedor
      WHERE vendedor_id = $1 AND stock < 5;
    `;

    // 3. Top 3 productos más vendidos
    const topProductsQuery = `
      SELECT 
        cm.nombre,
        SUM(v.cantidad)::int as total_vendido
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
        COALESCE(SUM(iv.stock), 0)::int as total_productos,
        COALESCE(SUM(iv.stock * iv.precio_personalizado), 0)::float8 as valor_total
      FROM inventario_vendedor iv
      WHERE iv.vendedor_id = $1;
    `;

    // 5. Últimas 5 ventas (para actividad reciente)
    const ultimasVentasQuery = `
      SELECT
        v.id,
        v.cantidad,
        v.precio_total::float8 as total,
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
        COALESCE(SUM(precio_total), 0)::float8 as total
      FROM ventas
      WHERE vendedor_id = $1 AND fecha >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY TO_CHAR(fecha, 'DD Mon'), DATE_TRUNC('day', fecha)
      ORDER BY DATE_TRUNC('day', fecha) ASC;
    `;

    // 7. Ventas mensuales del año actual
    const monthlyPerformanceQuery = `
      SELECT
        TO_CHAR(fecha, 'Month') as mes,
        COALESCE(SUM(precio_total), 0)::float8 as total
      FROM ventas
      WHERE vendedor_id = $1 AND fecha >= DATE_TRUNC('year', CURRENT_DATE)
      GROUP BY TO_CHAR(fecha, 'Month'), DATE_TRUNC('month', fecha)
      ORDER BY DATE_TRUNC('month', fecha) ASC;
    `;

    // 8. Ventas totales por año
    const yearlyPerformanceQuery = `
      SELECT
        EXTRACT(YEAR FROM fecha)::int AS anio,
        COALESCE(SUM(precio_total), 0)::float8 AS total
      FROM ventas
      WHERE vendedor_id = $1
      GROUP BY EXTRACT(YEAR FROM fecha)
      ORDER BY anio ASC;
    `;

    // Ejecutar todas las consultas
    const [summary, lowStock, topProducts, inventory, ultimasVentas, recent, monthly, yearly] = await Promise.all([
      pool.query(summaryQuery, [vendorId]),
      pool.query(lowStockQuery, [vendorId]),
      pool.query(topProductsQuery, [vendorId]),
      pool.query(inventoryQuery, [vendorId]),
      pool.query(ultimasVentasQuery, [vendorId]),
      pool.query(recentActivityQuery, [vendorId]),
      pool.query(monthlyPerformanceQuery, [vendorId]),
      pool.query(yearlyPerformanceQuery, [vendorId]),
    ]);

    res.json({
      resumen: summary.rows[0],
      alertas: lowStock.rows[0],
      top_productos: topProducts.rows,
      inventario: inventory.rows[0],
      ultimas_ventas: ultimasVentas.rows,
      grafica_reciente: recent.rows,
      grafica_mensual: monthly.rows,
      grafica_anual: yearly.rows,
    });

  } catch (error) {
    console.error("Error en getDashboardStats:", error);
    res.status(500).json({ error: 'No se pudieron generar las estadísticas.' });
  }
};