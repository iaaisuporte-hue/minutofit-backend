import jwt, { SignOptions } from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

export interface JWTPayload {
  id: number;
  email: string;
  role: 'user' | 'personal' | 'nutri' | 'admin';
  profileCompleted: boolean;
  accessProfile?: string;
}

export interface RefreshTokenPayload {
  jti: string;
  id: number;
  email: string;
}

if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set in environment variables');
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';
const JWT_REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';

export function generateAccessToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY as string } as SignOptions);
}

export function generateRefreshToken(base: Omit<RefreshTokenPayload, 'jti'>): string {
  const payload: RefreshTokenPayload = { ...base, jti: uuidv4() };
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRY as string } as SignOptions);
}

export function verifyAccessToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload & { exp: number } {
  return jwt.verify(token, JWT_REFRESH_SECRET) as RefreshTokenPayload & { exp: number };
}
