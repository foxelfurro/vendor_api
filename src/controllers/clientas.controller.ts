import { Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

// --- 1. OBTENER LISTA DE CLIENTAS ---
export const getClientas = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;

  try {
    const query = `
      SELECT id, nombre, telefono, detalles, saldo_pendiente, fecha_proximo_pago, created_at 
      FROM clientas 
      WHERE vendedor_id = $1 
      ORDER BY nombre ASC
    `;
    const { rows } = await pool.query(query, [vendorId]);
    res.json(rows);
  } catch (error) {
    console.error('Error en getClientas:', error);
    res.status(500).json({ error: 'Error al obtener clientas' });
  }
};

// --- 2. CREAR CLIENTA NUEVA ---
export const createClienta = async (req: AuthRequest, res: Response): Promise<any> => {
  const vendorId = req.user?.user_id;
  const { nombre, telefono, detalles } = req.body;

  if (!nombre) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }

  try {
    const query = `
      INSERT INTO clientas (vendedor_id, nombre, telefono, detalles)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const { rows } = await pool.query(query, [vendorId, nombre, telefono, detalles || {}]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error en createClienta:', error);
    res.status(500).json({ error: 'Error al crear la clienta' });
  }
};

// --- 2.5 ACTUALIZAR CLIENTA ---
export const updateClienta = async (req: AuthRequest, res: Response): Promise<any> => {
  const vendorId = req.user?.user_id;
  const { id } = req.params;
  const { nombre, telefono, detalles, fecha_proximo_pago } = req.body;

  try {
    const query = `
      UPDATE clientas 
      SET nombre = COALESCE($1, nombre),
          telefono = COALESCE($2, telefono),
          detalles = COALESCE($3, detalles),
          fecha_proximo_pago = $4
      WHERE id = $5 AND vendedor_id = $6
      RETURNING *
    `;
    const { rows } = await pool.query(query, [nombre, telefono, detalles || {}, fecha_proximo_pago || null, id, vendorId]);
    if (rows.length === 0) return res.status(404).json({ error: 'Clienta no encontrada' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error en updateClienta:', error);
    res.status(500).json({ error: 'Error al actualizar clienta' });
  }
};

// --- 2.6 ELIMINAR CLIENTA ---
export const deleteClienta = async (req: AuthRequest, res: Response): Promise<any> => {
  const vendorId = req.user?.user_id;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const clientaRes = await client.query('SELECT saldo_pendiente FROM clientas WHERE id = $1 AND vendedor_id = $2', [id, vendorId]);
    if (clientaRes.rowCount === 0) throw new Error('Clienta no encontrada');
    
    if (Number(clientaRes.rows[0].saldo_pendiente) > 0) {
       throw new Error('No puedes eliminar a una clienta que tiene saldo pendiente. Debe liquidar su deuda primero.');
    }

    // Desvincular ventas para no borrar el historial contable
    await client.query('UPDATE ventas SET clienta_id = NULL WHERE clienta_id = $1', [id]);
    
    await client.query('DELETE FROM clientas WHERE id = $1', [id]);
    
    await client.query('COMMIT');
    res.json({ message: 'Clienta eliminada correctamente' });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Error en deleteClienta:', error);
    res.status(400).json({ error: error.message || 'Error al eliminar clienta' });
  } finally {
    client.release();
  }
};

// --- 2.7 OBTENER ALERTAS DE COBROS DE HOY ---
export const getCobrosHoyCount = async (req: AuthRequest, res: Response): Promise<any> => {
  const vendorId = req.user?.user_id;
  try {
    const query = `
      SELECT COUNT(id)::int as count 
      FROM clientas 
      WHERE vendedor_id = $1 AND saldo_pendiente > 0 AND fecha_proximo_pago <= CURRENT_DATE;
    `;
    const { rows } = await pool.query(query, [vendorId]);
    res.json({ count: rows[0].count });
  } catch (error) {
    res.status(500).json({ error: 'Error al cargar cobros' });
  }
};

// --- 3. REGISTRAR UN ABONO ---
export const registerAbono = async (req: AuthRequest, res: Response): Promise<any> => {
  const vendorId = req.user?.user_id;
  const { venta_id, monto } = req.body;
  
  const montoNum = Number(monto);
  if (!venta_id || !Number.isFinite(montoNum) || montoNum <= 0) {
    return res.status(400).json({ error: 'Monto inválido o falta venta_id' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Obtener la venta para validar
    const ventaQuery = `SELECT id, clienta_id, saldo_restante, estado_pago FROM ventas WHERE id = $1 AND vendedor_id = $2 FOR UPDATE`;
    const ventaResult = await client.query(ventaQuery, [venta_id, vendorId]);

    if (ventaResult.rowCount === 0) {
      throw new Error('Venta no encontrada o no te pertenece.');
    }

    const venta = ventaResult.rows[0];
    if (venta.estado_pago === 'PAGADO' || venta.saldo_restante <= 0) {
      throw new Error('Esta venta ya está pagada por completo.');
    }

    if (montoNum > venta.saldo_restante) {
      throw new Error(`El monto supera el saldo restante ($${venta.saldo_restante})`);
    }

    // 2. Registrar el abono
    await client.query(`INSERT INTO abonos (venta_id, monto) VALUES ($1, $2)`, [venta_id, montoNum]);

    // 3. Actualizar la venta
    const nuevoSaldo = Number(venta.saldo_restante) - montoNum;
    const nuevoEstado = nuevoSaldo <= 0 ? 'PAGADO' : 'EN_ABONOS';

    await client.query(
      `UPDATE ventas SET saldo_restante = $1, estado_pago = $2 WHERE id = $3`, 
      [nuevoSaldo, nuevoEstado, venta_id]
    );

    // 4. Actualizar el saldo global de la clienta
    if (venta.clienta_id) {
      await client.query(
        `UPDATE clientas SET saldo_pendiente = saldo_pendiente - $1 WHERE id = $2`, 
        [montoNum, venta.clienta_id]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Abono registrado con éxito', saldo_restante: nuevoSaldo, estado: nuevoEstado });

  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Error en registerAbono:', error);
    res.status(400).json({ error: error.message || 'Error al procesar el abono' });
  } finally {
    client.release();
  }
};

// --- 4. OBTENER ESTADO DE CUENTA DE UNA CLIENTA ---
export const getClientaDetalle = async (req: AuthRequest, res: Response): Promise<any> => {
  const vendorId = req.user?.user_id;
  const { id } = req.params;

  try {
    // Info de la clienta
    const clientaRes = await pool.query(`SELECT * FROM clientas WHERE id = $1 AND vendedor_id = $2`, [id, vendorId]);
    if (clientaRes.rowCount === 0) return res.status(404).json({ error: 'Clienta no encontrada' });
    
    // Sus ventas (con o sin abonos)
    const ventasRes = await pool.query(`
      SELECT v.id, v.fecha, v.precio_total, v.estado_pago, v.saldo_restante, c.nombre as producto
      FROM ventas v
      JOIN inventario_vendedor iv ON v.inventario_id = iv.id
      JOIN catalogo_maestro c ON iv.producto_maestro_id = c.id
      WHERE v.clienta_id = $1
      ORDER BY v.fecha DESC
    `, [id]);

    res.json({
      clienta: clientaRes.rows[0],
      historial: ventasRes.rows
    });
  } catch (error) {
    console.error('Error en getClientaDetalle:', error);
    res.status(500).json({ error: 'Error al obtener detalles' });
  }
};
