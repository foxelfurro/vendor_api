import { Request, Response } from 'express';
import { pool } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

export const getVapidPublicKey = (req: Request, res: Response) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || 'BOeStfB8mHs00pAkKgnThLDf9dMcpMhpV9YqmayP-i8wGBur0MdQ7xdFUYVPoXuq_OepFr0axaZvXzPRXRxpeic' });
};

export const subscribeToPush = async (req: AuthRequest, res: Response): Promise<any> => {
  const vendorId = req.user?.user_id;
  const { subscription } = req.body;

  if (!subscription) {
    return res.status(400).json({ error: 'No subscription provided' });
  }

  try {
    // Evitar duplicados exactos comparando el endpoint
    const checkQuery = `SELECT id FROM push_subscriptions WHERE vendedor_id = $1 AND subscription->>'endpoint' = $2`;
    const checkRes = await pool.query(checkQuery, [vendorId, subscription.endpoint]);

    if (checkRes.rowCount === 0) {
      const query = `
        INSERT INTO push_subscriptions (vendedor_id, subscription) 
        VALUES ($1, $2)
      `;
      await pool.query(query, [vendorId, subscription]);
    }
    
    res.status(201).json({ message: 'Subscribed successfully' });
  } catch (error) {
    console.error('Error saving subscription', error);
    res.status(500).json({ error: 'Error saving subscription' });
  }
};
