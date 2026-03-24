import jwt, { SignOptions } from 'jsonwebtoken';

export interface JWTPayload {
  id: number;
  email: string;
  role: 'user' | 'personal' | 'nutri' | 'admin';
  profileCompleted: boolean;
  accessProfile?: string;
}

export interface RefreshTokenPayload {
  id: number;
  email: string;
}

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key_here';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your_jwt_refresh_secret_key_here';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';
const JWT_REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';

export function generateAccessToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY as string } as SignOptions);
}

export function generateRefreshToken(payload: RefreshTokenPayload): string {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRY as string } as SignOptions);
}

export function verifyAccessToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, JWT_REFRESH_SECRET) as RefreshTokenPayload;
}
