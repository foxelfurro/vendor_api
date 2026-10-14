/**
 * @file auth.middleware.ts
 * @description Middlewares de autenticación y autorización.
 *
 * - `verifyToken`  → Verifica la cookie JWT y adjunta el payload al objeto Request.
 * - `isAdmin`      → Verifica que el usuario tenga rol de administrador (rol_id = 1).
 * - `AuthRequest`  → Interfaz extendida de Request que incluye el campo `user`.
 */

import { Request, Response, NextFunction, CookieOptions } from 'express';
import jwt from 'jsonwebtoken';

/**
 * Opciones de la cookie de sesión. Se usan tanto al crearla (login) como al
 * borrarla (logout / token inválido): el navegador solo elimina la cookie si
 * `domain`, `path`, `secure` y `sameSite` coinciden con los de su creación.
 */
export const AUTH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'none',
  domain: '.qlatte.com',
  path: '/',
};

/** Estructura del payload incluido en el JWT de la aplicación. */
interface TokenPayload {
  user_id: string;
  email: string;
  marca_id: number;
  rol: number;
}

export interface AuthRequest extends Request {
  user?: TokenPayload;
}

export const verifyToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  // Intentamos sacar el token de las cookies o del header Authorization
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Sesión expirada o no iniciada.' });
  }

  try {
    // Rotación de secreto: los tokens nuevos se firman con JWT_SECRET, pero
    // mientras exista JWT_SECRET_OLD se siguen aceptando los firmados con la
    // clave anterior (duran 24h). Pasado ese plazo, borra JWT_SECRET_OLD.
    let decoded: TokenPayload;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET as string) as TokenPayload;
    } catch (err) {
      const oldSecret = process.env.JWT_SECRET_OLD;
      if (!oldSecret) throw err;
      decoded = jwt.verify(token, oldSecret) as TokenPayload;
    }

    // Asignamos el usuario decodificado a la request
    req.user = decoded;
    next();
  } catch (error) {
    // Si el token es inválido, limpiamos la cookie por seguridad
    res.clearCookie('token', AUTH_COOKIE_OPTIONS);
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
};

export const isAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  // Usamos el encadenamiento opcional ?. para evitar errores si req.user es undefined
  if (req.user?.rol !== 1) {
    return res.status(403).json({ error: 'Acceso denegado. Se requieren permisos de administrador.' });
  }
  next();
};
