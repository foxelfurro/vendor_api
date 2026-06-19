/**
 * @file vendor.controller.ts
 * @description Controlador de operaciones del vendedor.
 *
 * Endpoints que maneja (todos requieren token válido):
 *  - GET    /vendor/explore           → Catálogo maestro disponible para agregar.
 *  - GET    /vendor/inventory          → Inventario actual del vendedor.
 *  - POST   /vendor/inventory          → Agrega joya del catálogo al inventario.
 *  - POST   /vendor/inventory/custom   → Crea una joya propia (pendiente de aprobación).
 *  - PUT    /vendor/inventory/:id      → Actualiza precio o stock de un ítem.
 *  - DELETE /vendor/inventory/:id      → Elimina un ítem del inventario.
 *  - GET    /store/:slug               → Catálogo público de la tienda de una vendedora.
 *  - PUT    /vendor/store-settings     → Actualiza datos de la tienda (slug, teléfono, personalización).
 */

import { Request, Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { Resend } from 'resend'; 

// Inicializamos Resend (asegúrate de tener tu RESEND_API_KEY en el .env)
const resend = new Resend(process.env.RESEND_API_KEY || 're_tu_api_key_aqui');

// GET /vendor/explore
// Muestra productos del catálogo de SU MARCA que AÚN NO están en su inventario.
//
// Admin: paginación + búsqueda + filtros se aplican en el servidor (en SQL).
// El servidor NUNCA materializa toda la tabla en memoria; solo el slice solicitado.
// Query params soportados por admin: page, limit, search, categoria_id,
// orden_precio (asc|desc), precio_min, precio_max.
//
// Vendedora: como antes (lista plana sin paginar, ya está acotada por marca/no-en-inventario).
export const exploreCatalog = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const marcaId = req.user?.marca_id;
  const esAdmin = req.user?.rol === 1;

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, parseInt(req.query.limit as string) || 30);
  const offset = (page - 1) * pageSize;

  try {
    const columnas = `
      cm.id, cm.sku, cm.skus_anteriores, cm.nombre, cm.descripcion,
      cm.ruta_imagen, cm.precio_sugerido, cm.marca_id, cm.categoria_id,
      c.nombre AS categoria
    `;

    if (esAdmin) {
      // ── Filtros opcionales del admin ─────────────────────────────────────
      const search = String(req.query.search ?? '').trim().toLowerCase();
      const categoriaIdRaw = req.query.categoria_id;
      const categoriaId =
        categoriaIdRaw != null && categoriaIdRaw !== '' ? parseInt(categoriaIdRaw as string) : null;
      const ordenPrecio = req.query.orden_precio === 'asc' || req.query.orden_precio === 'desc'
        ? (req.query.orden_precio as 'asc' | 'desc')
        : null;
      const precioMin = req.query.precio_min != null && req.query.precio_min !== ''
        ? Number(req.query.precio_min)
        : null;
      const precioMax = req.query.precio_max != null && req.query.precio_max !== ''
        ? Number(req.query.precio_max)
        : null;

      const conditions: string[] = ['cm.estado = true'];
      const params: any[] = [];
      let i = 0;

      if (search) {
        // Busca por nombre, SKU vigente y SKUs anteriores (case-insensitive).
        i += 1;
        const p = `%${search}%`;
        conditions.push(
          `(LOWER(cm.nombre) LIKE $${i} OR LOWER(cm.sku) LIKE $${i} OR EXISTS (
             SELECT 1 FROM unnest(cm.skus_anteriores) s WHERE LOWER(s) LIKE $${i}
           ))`
        );
        params.push(p);
      }
      if (Number.isFinite(categoriaId) && categoriaId !== null) {
        i += 1;
        conditions.push(`cm.categoria_id = $${i}`);
        params.push(categoriaId);
      }
      if (Number.isFinite(precioMin) && precioMin !== null) {
        i += 1;
        conditions.push(`cm.precio_sugerido >= $${i}`);
        params.push(precioMin);
      }
      if (Number.isFinite(precioMax) && precioMax !== null) {
        i += 1;
        conditions.push(`cm.precio_sugerido <= $${i}`);
        params.push(precioMax);
      }

      // Orden: por precio si se pidió, si no por nombre (alfabético natural).
      let orderClause = 'cm.nombre';
      if (ordenPrecio === 'asc') orderClause = 'cm.precio_sugerido ASC NULLS LAST, cm.nombre';
      else if (ordenPrecio === 'desc') orderClause = 'cm.precio_sugerido DESC NULLS LAST, cm.nombre';

      const limitIdx = i + 1;
      const offsetIdx = i + 2;
      params.push(pageSize, offset);

      const adminQuery = `
        SELECT ${columnas}, COUNT(*) OVER() AS total_count
        FROM catalogo_maestro cm
        LEFT JOIN categorias c ON cm.categoria_id = c.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderClause}
        LIMIT $${limitIdx} OFFSET $${offsetIdx};
      `;

      const { rows } = await pool.query(adminQuery, params);
      const totalCount = rows.length > 0 ? parseInt(rows[0].total_count) : 0;
      return res.json({
        data: rows.map(({ total_count, ...r }) => r),
        pagination: { page, pageSize, total: totalCount, totalPages: Math.ceil(totalCount / pageSize) }
      });
    }

    // ── Vendedora: ya está acotada por marca + no-en-inventario, devuelve lista plana ──
    const vendorQuery = `
      SELECT ${columnas}
      FROM catalogo_maestro cm
      LEFT JOIN inventario_vendedor iv
        ON cm.id = iv.producto_maestro_id AND iv.vendedor_id = $1
      LEFT JOIN categorias c ON cm.categoria_id = c.id
      WHERE cm.marca_id = $2
        AND cm.estado = true
        AND iv.producto_maestro_id IS NULL;
    `;
    const { rows } = await pool.query(vendorQuery, [vendorId, marcaId]);
    res.json(rows);
  } catch (error) {
    console.error("Error en exploreCatalog:", error);
    res.status(500).json({ error: 'Error al cargar el catálogo para explorar.' });
  }
};

// GET /vendor/inventory
// Carga el inventario híbrido usando COALESCE para fusionar maestro e independiente
export const getInventory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;

  try {
    const query = `
      SELECT
        iv.id AS inventario_id,
        iv.stock,
        iv.precio_personalizado,
        iv.producto_maestro_id,
        cm.sku AS sku,
        cm.skus_anteriores,
        cm.nombre AS nombre,
        cm.descripcion AS descripcion,
        COALESCE(cm.precio_sugerido, 0) AS precio_sugerido,
        cm.ruta_imagen AS ruta_imagen,
        cm.categoria_id,
        c.nombre AS categoria,
        cm.estado,
        CASE WHEN cm.creado_por = $1 THEN true ELSE false END AS es_custom
      FROM inventario_vendedor iv
      JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      LEFT JOIN categorias c ON cm.categoria_id = c.id
      WHERE iv.vendedor_id = $1;
    `;
    const { rows } = await pool.query(query, [vendorId]);
    res.json(rows);
  } catch (error) {
    console.error("Error en getInventory:", error);
    res.status(500).json({ error: 'Error al cargar tu inventario personal.' });
  }
};

// POST /vendor/inventory
// Vincula una joya del catálogo maestro al inventario del vendedor
export const addToInventory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const { producto_maestro_id, stock, precio_personalizado } = req.body;

  try {
    // Verificar que la joya pertenece a la marca del vendedor o fue creada por él mismo,
    // para evitar que un vendedor agregue joyas de otra marca a su inventario.
    const { rows: vendorRows } = await pool.query(
      `SELECT marca_id FROM usuarios WHERE id = $1`,
      [vendorId]
    );
    if (vendorRows.length === 0) {
      return res.status(401).json({ error: 'Vendedor no encontrado.' });
    }
    const vendorMarcaId = vendorRows[0].marca_id;

    const { rows: joyas } = await pool.query(
      `SELECT id FROM catalogo_maestro
       WHERE id = $1 AND (marca_id = $2 OR creado_por = $3)`,
      [producto_maestro_id, vendorMarcaId, vendorId]
    );
    if (joyas.length === 0) {
      return res.status(403).json({ error: 'No tienes permiso para agregar esta joya a tu inventario.' });
    }

    const query = `
      WITH nuevo_item AS (
        INSERT INTO inventario_vendedor
          (vendedor_id, producto_maestro_id, stock, precio_personalizado)
        VALUES
          ($1, $2, $3, $4)
        RETURNING *
      )
      SELECT ni.*, cm.ruta_imagen, cm.nombre, cm.sku
      FROM nuevo_item ni
      JOIN catalogo_maestro cm ON ni.producto_maestro_id = cm.id;
    `;

    const values = [vendorId, producto_maestro_id, stock, precio_personalizado];
    const { rows } = await pool.query(query, values);

    res.status(201).json({
      message: '¡Producto agregado a tu inventario exitosamente!',
      producto: rows[0]
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Esta joya ya está en tu inventario. Ve a la pestaña de "Inventario" para actualizar el stock.'
      });
    }
    console.error("Error en addToInventory:", error);
    res.status(500).json({ error: 'Hubo un error interno al guardar la joya en tu inventario.' });
  }
};

// PUT /vendor/inventory/:id
// Actualiza dinámicamente precio_personalizado, stock o ambos
export const updateInventoryItem = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const { id } = req.params; 
  const { stock, precio_personalizado } = req.body;

  try {
    const query = `
      UPDATE inventario_vendedor
      SET 
        stock = COALESCE($1, stock),
        precio_personalizado = COALESCE($2, precio_personalizado)
      WHERE id = $3 AND vendedor_id = $4
      RETURNING *;
    `;
    const { rows } = await pool.query(query, [stock, precio_personalizado, id, vendorId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado en tu inventario.' });
    }

    res.json({
      message: 'Joya actualizada exitosamente.',
      producto: rows[0]
    });
  } catch (error) {
    console.error("Error en updateInventoryItem:", error);
    res.status(500).json({ error: 'Error al actualizar los datos del producto.' });
  }
};

// DELETE /vendor/inventory/:id
// Elimina una joya de la vitrina privada del vendedor.
// Si la joya era una "pieza propia" pendiente (estado = false) creada por este
// mismo vendedor y nadie más la tiene, también se borra del catálogo maestro.
export const deleteInventoryItem = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const { id } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Validación: verificar si hay ventas asociadas a este ítem de inventario
    const ventasCheck = await client.query(
      `SELECT COUNT(*) as count FROM ventas WHERE inventario_id = $1;`,
      [id]
    );

    const ventasCount = parseInt(ventasCheck.rows[0].count);
    if (ventasCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `No se puede eliminar esta joya porque tiene ${ventasCount} ${ventasCount === 1 ? 'venta' : 'ventas'} asociada${ventasCount === 1 ? '' : 's'}. El historial de ventas debe ser preservado.`
      });
    }

    const del = await client.query(
      `DELETE FROM inventario_vendedor
       WHERE id = $1 AND vendedor_id = $2
       RETURNING producto_maestro_id;`,
      [id, vendorId]
    );

    if (del.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'El producto no existe en tu inventario.' });
    }

    const productoMaestroId = del.rows[0].producto_maestro_id;

    // Limpieza: si era una pieza propia pendiente del propio vendedor y ya
    // nadie la referencia, se elimina del catálogo maestro para no dejar basura.
    await client.query(
      `DELETE FROM catalogo_maestro cm
       WHERE cm.id = $1
         AND cm.estado = false
         AND cm.creado_por = $2
         AND NOT EXISTS (
           SELECT 1 FROM inventario_vendedor iv WHERE iv.producto_maestro_id = cm.id
         );`,
      [productoMaestroId, vendorId]
    );

    await client.query('COMMIT');
    res.json({ message: 'Joya eliminada de tu vitrina correctamente.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Error en deleteInventoryItem:", error);
    res.status(500).json({ error: 'Error al eliminar el producto de tu inventario.' });
  } finally {
    client.release();
  }
};
// GET /store/:slug
// Endpoint PÚBLICO para ver la tienda de una vendedora específica
export const getSellerCatalogBySlug = async (req: Request, res: Response) => {
  const { slug } = req.params;

  try {
    // 1. AÑADIDO: 'store_name' y 'personalizacion' a la consulta SQL
    const userQuery = `SELECT id, nombre, store_name, telefono, personalizacion FROM usuarios WHERE store_slug = $1`;
    const userResult = await pool.query(userQuery, [slug]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Catálogo no encontrado.' });
    }

    const vendor = userResult.rows[0];

    const inventoryQuery = `
      SELECT
        iv.id AS inventario_id,
        iv.stock,
        iv.precio_personalizado,
        cm.id AS producto_maestro_id,
        cm.nombre AS nombre,
        cm.sku AS sku,
        COALESCE(cm.descripcion, 'Pieza exclusiva de nuestra colección independiente.') AS descripcion,
        cm.ruta_imagen AS ruta_imagen,
        COALESCE(cm.precio_sugerido, 0) AS precio_sugerido,
        cm.categoria_id,
        c.nombre AS categoria
      FROM inventario_vendedor iv
      JOIN catalogo_maestro cm ON iv.producto_maestro_id = cm.id
      LEFT JOIN categorias c ON cm.categoria_id = c.id
      WHERE iv.vendedor_id = $1 AND iv.stock > 0;
    `;
    const inventoryResult = await pool.query(inventoryQuery, [vendor.id]);

    res.json({
      vendor: {
        nombre: vendor.nombre,
        store_name: vendor.store_name, // 2. AÑADIDO: Se envía al frontend
        telefono: vendor.telefono,
        // 3. AÑADIDO: personalización visual de la tienda (color, logo, etc.)
        personalizacion: vendor.personalizacion ?? {},
      },
      products: inventoryResult.rows
    });

  } catch (error) {
    console.error("Error en getSellerCatalogBySlug:", error);
    res.status(500).json({ error: 'Error al cargar el catálogo.' });
  }
};

// PUT /vendor/store-settings
export const updateStoreSettings = async (req: AuthRequest, res: Response): Promise<any> => {
  const userId = req.user?.user_id;
  // `store_name` y `personalizacion` son opcionales: si no llegan, se conservan
  // los valores que ya tenga la vendedora (COALESCE en el UPDATE).
  const { store_name, store_slug, telefono, personalizacion } = req.body;

  if (!store_slug || !telefono) {
    return res.status(400).json({ error: 'El nombre de la tienda y el teléfono son obligatorios.' });
  }

  try {
    const cleanSlug = store_slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const cleanPhone = telefono.replace(/\D/g, '');

    const checkQuery = 'SELECT id FROM usuarios WHERE store_slug = $1 AND id != $2';
    const checkResult = await pool.query(checkQuery, [cleanSlug, userId]);

    if (checkResult.rows.length > 0) {
      return res.status(400).json({ error: 'Este nombre de tienda ya está en uso. Por favor elige otro.' });
    }

    // La personalización es puramente visual; se serializa a JSON para la
    // columna JSONB. Si no llega en la petición, se mantiene la existente.
    const personalizacionJson =
      personalizacion && typeof personalizacion === 'object'
        ? JSON.stringify(personalizacion)
        : null;

    const updateQuery = `
      UPDATE usuarios
      SET store_name = COALESCE($1, store_name),
          store_slug = $2,
          telefono = $3,
          personalizacion = COALESCE($4::jsonb, personalizacion)
      WHERE id = $5
      RETURNING store_name, store_slug, telefono, personalizacion;
    `;
    const { rows } = await pool.query(updateQuery, [
      store_name ?? null,
      cleanSlug,
      cleanPhone,
      personalizacionJson,
      userId,
    ]);

    return res.json({
      message: '¡Configuración de tienda guardada exitosamente!',
      data: rows[0]
    });

  } catch (error: any) {
    // El slug tiene una restricción UNIQUE. Si otra vendedora lo tomó entre la
    // verificación y el UPDATE (condición de carrera), Postgres lanza 23505.
    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Este nombre de tienda ya está en uso. Por favor elige otro.' });
    }
    console.error(" ERROR AL ACTUALIZAR TIENDA:", error);
    return res.status(500).json({ error: 'Error al actualizar la configuración de tu tienda.' });
  }
};

// POST /vendor/inventory/custom
// Registra una joya propia. La pieza se crea en el catálogo maestro con
// estado = false (pendiente de aprobación) y queda vinculada al inventario del
// vendedor, de modo que aparece de inmediato en su inventario y en su tienda,
// pero NO en el catálogo maestro del resto hasta que un administrador la apruebe.
export const addCustomToInventory = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  const marcaId = req.user?.marca_id;
  const vendorEmail = req.user?.email || 'Vendedor Anónimo';
  // imagen_url: URL pública de R2 obtenida tras subir la imagen con /uploads/presigned-url.
  // Ya no se acepta Base64 — el archivo se sube directo a R2 desde el frontend.
  const { nombre, sku, stock, precio_personalizado, imagen_url } = req.body;

  if (!nombre || !sku || stock === undefined || precio_personalizado === undefined) {
    return res.status(400).json({ error: 'Faltan datos para crear tu joya personalizada.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Se crea la joya en el catálogo maestro como pendiente (estado = false).
    //    La categoría queda en NULL: la asignará el administrador al aprobarla.
    const joya = await client.query(
      `INSERT INTO catalogo_maestro
         (sku, nombre, ruta_imagen, precio_sugerido, categoria_id, marca_id, estado, creado_por)
       VALUES ($1, $2, $3, $4, NULL, $5, false, $6)
       RETURNING id;`,
      [sku, nombre, imagen_url || null, precio_personalizado, marcaId, vendorId]
    );
    const productoMaestroId = joya.rows[0].id;

    // 2. Se vincula a su inventario personal.
    const inv = await client.query(
      `INSERT INTO inventario_vendedor
         (vendedor_id, producto_maestro_id, stock, precio_personalizado)
       VALUES ($1, $2, $3, $4)
       RETURNING *;`,
      [vendorId, productoMaestroId, stock, precio_personalizado]
    );

    await client.query('COMMIT');

    // Notificación en segundo plano para que el administrador revise la pieza.
    resend.emails.send({
      from: 'Notificaciones Qlatte <onboarding@resend.dev>',
      to: 'admin@qlatte.com',
      subject: `💎 Nueva Joya Propia pendiente de aprobación: ${nombre}`,
      html: `
        <h2>Una vendedora registró una joya propia</h2>
        <p>Está pendiente de revisión y aprobación en el panel de administración:</p>
        <ul>
          <li><strong>Vendedora:</strong> ${vendorEmail}</li>
          <li><strong>Nombre de la pieza:</strong> ${nombre}</li>
          <li><strong>SKU asignado:</strong> ${sku}</li>
          <li><strong>Precio fijado:</strong> $${precio_personalizado}</li>
          <li><strong>¿Subió fotografía?:</strong> ${imagen_url ? 'Sí' : 'No'}</li>
        </ul>
      `
    }).catch(err => console.error("Error silencioso de Resend:", err));

    res.status(201).json({
      message: '¡Joya propia creada! Ya aparece en tu inventario y tu tienda. Un administrador la revisará para publicarla en el catálogo maestro.',
      producto: inv.rows[0]
    });

  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ya existe una joya con ese SKU. Usa un código diferente.' });
    }
    console.error("Error en addCustomToInventory:", error);
    res.status(500).json({ error: 'Hubo un error al guardar tu joya personalizada.' });
  } finally {
    client.release();
  }
};

// --- CONTEO DE ALERTAS DE STOCK BAJO (para badge en sidebar) ---
export const getStockAlerts = async (req: AuthRequest, res: Response) => {
  const vendorId = req.user?.user_id;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM inventario_vendedor WHERE vendedor_id = $1 AND stock > 0 AND stock <= 3`,
      [vendorId]
    );
    res.json({ count: rows[0].count });
  } catch (error) {
    console.error('Error en getStockAlerts:', error);
    res.status(500).json({ error: 'No se pudo obtener las alertas de stock.' });
  }
};