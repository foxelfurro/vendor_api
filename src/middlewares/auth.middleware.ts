import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Definimos la interfaz del Payload para que sea reutilizable
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as TokenPayload;
    
    // Asignamos el usuario decodificado a la request
    req.user = decoded;
    next();
  } catch (error) {
    // Si el token es inválido, limpiamos la cookie por seguridad
    res.clearCookie('token');
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