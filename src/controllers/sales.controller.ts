/**
 * @file sales.controller.ts
 * @description Controlador de registro y consulta de ventas.
 *
 * Endpoints que maneja (todos requieren token válido):
 *  - POST /sales/register  → Registra una venta y descuenta stock en transacción.
 *  - GET  /sales/history   → Historial de ventas del vendedor autenticado.
 */

import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';



// --- 1. REGISTRAR VENTA (Solo control de inventario) ---
// El joyero usa esto para decir "Hoy vendí esta joya, descuéntala de mi stock"
export const registerSale = async (req: AuthRequest, res: Response): Promise<any> => {
  const { inventario_id, cantidad, precio_unitario } = req.body;
  const vendorId = req.user?.user_id;

  // Validación de entrada. Sin ella, una cantidad negativa o cero AUMENTARÍA el
  // stock (stock - cantidad) y dejaría registrada una venta inválida; un precio
  // no numérico produciría un total NaN.
  const cant = Number(cantidad);
  const precio = Number(precio_unitario);
  if (!inventario_id || !Number.isInteger(cant) || cant <= 0) {
    return res.status(400).json({ error: 'La cantidad debe ser un número entero mayor que cero.' });
  }
  if (!Number.isFinite(precio) || precio < 0) {
    return res.status(400).json({ error: 'El precio unitario no es válido.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Descontamos del stock
    const updateStockQuery = `
      UPDATE inventario_vendedor
      SET stock = stock - $1
      WHERE id = $2 AND vendedor_id = $3 AND stock >= $1
      RETURNING id, stock;
    `;
    const stockResult = await client.query(updateStockQuery, [cant, inventario_id, vendorId]);

    if (stockResult.rowCount === 0) {
      throw new Error('No hay stock suficiente o el producto no pertenece a tu inventario.');
    }

    // 2. Registramos el movimiento para sus reportes
    const precioTotal = cant * precio;
    const insertSaleQuery = `
      INSERT INTO ventas (vendedor_id, inventario_id, cantidad, precio_total, fecha)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id;
    `;
    await client.query(insertSaleQuery, [vendorId, inventario_id, cant, precioTotal]);

    await client.query('COMMIT');

    res.status(201).json({
      message: '¡Venta registrada con éxito!',
      stock_restante: stockResult.rows[0].stock
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error("Error en registerSale:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
};

// --- 2. EXPORTAR HISTORIAL COMPLETO (sin paginación) ---
export const exportSalesHistory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  try {
    const query = `
      SELECT
        v.id AS venta_id,
        v.cantidad,
        v.precio_total,
        v.fecha,
        cm.nombre AS producto_nombre,
        cm.sku
      FROM ventas v
      INNER JOIN inventario_vendedor iv ON v.inventario_id = iv.id
      INNER JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      WHERE v.vendedor_id = $1
      ORDER BY v.fecha DESC;
    `;
    const { rows } = await pool.query(query, [vendorId]);
    res.json(rows);
  } catch (error) {
    console.error('Error en exportSalesHistory:', error);
    res.status(500).json({ error: 'No se pudo exportar el historial de ventas.' });
  }
};

// --- 3. OBTENER HISTORIAL DE VENTAS ---
// El joyero usa esto para ver su panel de "Ventas de la semana/mes"
export const getSalesHistory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  try {
    const query = `
      SELECT
        v.id AS venta_id,
        v.cantidad,
        v.precio_total,
        v.fecha,
        cm.nombre AS producto_nombre,
        cm.sku,
        cm.ruta_imagen,
        COUNT(*) OVER() AS total_count
      FROM ventas v
      INNER JOIN inventario_vendedor iv ON v.inventario_id = iv.id
      INNER JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      WHERE v.vendedor_id = $1
      ORDER BY v.fecha DESC
      LIMIT $2 OFFSET $3;
    `;
    const { rows } = await pool.query(query, [vendorId, pageSize, offset]);
    const totalCount = rows.length > 0 ? parseInt(rows[0].total_count) : 0;
    res.json({
      data: rows.map(({ total_count, ...r }) => r),
      pagination: { page, pageSize, total: totalCount, totalPages: Math.ceil(totalCount / pageSize) }
    });
  } catch (error) {
    console.error("Error en getSalesHistory:", error);
    res.status(500).json({ error: 'No se pudo cargar el historial de ventas.' });
  }
};