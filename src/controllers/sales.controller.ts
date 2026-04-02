import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

// 1. Importamos y configuramos Conekta
const Conekta = require('conekta');
Conekta.api_key = process.env.CONEKTA_PRIVATE_KEY || 'key_rFXLUER5xR1aVEXss68TE0o'; // Pon tu llave privada aquí
Conekta.locale = 'es';

// --- VENTA TRADICIONAL (Local / Efectivo) ---
export const registerSale = async (req: AuthRequest, res: Response) => {
  const { inventario_id, cantidad, precio_unitario } = req.body;
  const vendorId = req.user?.user_id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const updateStockQuery = `
      UPDATE inventario_vendedor 
      SET stock = stock - $1 
      WHERE id = $2 AND vendedor_id = $3 AND stock >= $1
      RETURNING id, stock;
    `;
    const stockResult = await client.query(updateStockQuery, [cantidad, inventario_id, vendorId]);

    if (stockResult.rowCount === 0) {
      throw new Error('No hay stock suficiente o el producto no pertenece a tu inventario.');
    }

    const precioTotal = cantidad * precio_unitario;
    const insertSaleQuery = `
      INSERT INTO ventas (vendedor_id, inventario_id, cantidad, precio_total)
      VALUES ($1, $2, $3, $4)
      RETURNING id;
    `;
    await client.query(insertSaleQuery, [vendorId, inventario_id, cantidad, precioTotal]);

    await client.query('COMMIT');

    res.status(201).json({
      message: '¡Venta registrada con éxito!',
      stock_restante: stockResult.rows[0].stock
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error("🔥 ERROR EN TRANSACCIÓN DE VENTA:", error.message);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
};

// --- NUEVA VENTA CON TARJETA (Conekta) ---
export const processCheckout = async (req: AuthRequest, res: Response) => {
  const { inventario_id, cantidad, precio_unitario, token_id, nombre_cliente, email_cliente } = req.body;
  const vendorId = req.user?.user_id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Descontar y verificar stock (igual que en venta tradicional)
    const updateStockQuery = `
      UPDATE inventario_vendedor 
      SET stock = stock - $1 
      WHERE id = $2 AND vendedor_id = $3 AND stock >= $1
      RETURNING id, stock;
    `;
    const stockResult = await client.query(updateStockQuery, [cantidad, inventario_id, vendorId]);

    if (stockResult.rowCount === 0) {
      throw new Error('No hay stock suficiente o el producto no pertenece a tu inventario.');
    }

    const precioTotal = cantidad * precio_unitario;

    // 2. Ejecutar el cobro en Conekta usando el Token
    const orden = await Conekta.Order.create({
      currency: "MXN",
      customer_info: {
        name: nombre_cliente || "Cliente VendorHub",
        email: email_cliente || "cliente@joyeriahub.com",
        phone: "+5218181818181" // Dato obligatorio en Conekta
      },
      line_items: [{
        name: "Joya ID: " + inventario_id,
        unit_price: Math.round(precio_unitario * 100), // Conekta exige el precio en centavos
        quantity: cantidad
      }],
      charges: [{
        payment_method: {
          type: "card",
          token_id: token_id // 💳 El token que mandamos desde React
        }
      }]
    });

    // 3. Registrar la venta en la tabla
    // (Opcional: Si en el futuro agregas la columna conekta_id a tu tabla 'ventas', puedes guardarlo aquí)
    const insertSaleQuery = `
      INSERT INTO ventas (vendedor_id, inventario_id, cantidad, precio_total)
      VALUES ($1, $2, $3, $4)
      RETURNING id;
    `;
    await client.query(insertSaleQuery, [vendorId, inventario_id, cantidad, precioTotal]);

    // 4. Confirmar todo (BD y Conekta fueron exitosos)
    await client.query('COMMIT');

    res.status(200).json({
      success: true,
      message: '¡Pago aprobado y venta registrada con éxito! 💎',
      stock_restante: stockResult.rows[0].stock,
      orden_conekta_id: orden.id
    });

  } catch (error: any) {
    // 5. Revertir BD si falla Conekta
    await client.query('ROLLBACK');
    console.error("🔥 ERROR EN CHECKOUT:", error);
    
    // Conekta devuelve errores en un array de "details"
    const mensajeError = error.details?.[0]?.message || error.message || "Hubo un problema procesando el pago.";
    res.status(400).json({ success: false, error: mensajeError });
  } finally {
    client.release();
  }
};

// --- GET /sales/history ---
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
