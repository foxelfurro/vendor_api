import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

export const registerSale = async (req: AuthRequest, res: Response) => {
  const { inventario_id, cantidad, precio_unitario } = req.body;
  const vendorId = req.user?.user_id;

  // 1. Iniciamos la conexión específica para la transacción
  const client = await pool.connect();

  try {
    // 2. COMENZAR TRANSACCIÓN
    await client.query('BEGIN');

    // 3. DESCONTAR STOCK (Y verificar que haya suficiente)
    const updateStockQuery = `
      UPDATE inventario_vendedor 
      SET stock = stock - $1 
      WHERE id = $2 AND vendedor_id = $3 AND stock >= $1
      RETURNING id, stock;
    `;
    const stockResult = await client.query(updateStockQuery, [cantidad, inventario_id, vendorId]);

    // Si rowCount es 0, significa que o el ID no existe, no es de este vendedor, o no hay stock suficiente
    if (stockResult.rowCount === 0) {
      throw new Error('No hay stock suficiente o el producto no pertenece a tu inventario.');
    }

    // 4. REGISTRAR LA VENTA
    const precioTotal = cantidad * precio_unitario;
    const insertSaleQuery = `
      INSERT INTO ventas (vendedor_id, inventario_id, cantidad, precio_total) -- <--- Mira aquí
      VALUES ($1, $2, $3, $4)
      RETURNING id;
    `;
    // Asegúrate de que el orden de los valores coincida:
    await client.query(insertSaleQuery, [vendorId, inventario_id, cantidad, precioTotal]);

    // 5. SI TODO SALIÓ BIEN, CONFIRMAR CAMBIOS
    await client.query('COMMIT');

    res.status(201).json({
      message: '¡Venta registrada con éxito!',
      stock_restante: stockResult.rows[0].stock
    });

  } catch (error: any) {
    // 6. SI ALGO FALLÓ, REVERTIR TODO (Rollback)
    await client.query('ROLLBACK');
    console.error("🔥 ERROR EN TRANSACCIÓN DE VENTA:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    // 7. Liberar el cliente al pool
    client.release();
  }
};

// GET /sales/history
export const getSalesHistory = async (req: AuthRequest, res: Response) => {
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
    console.error("🔥 ERROR AL OBTENER HISTORIAL:", error);
    res.status(500).json({ error: 'No se pudo cargar el historial de ventas.' });
  }
};