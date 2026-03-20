import axios from 'axios';
import jwt from 'jsonwebtoken';
import { createPublicKey } from 'crypto';

interface GoogleTokenPayload {
  iss: string;
  azp: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  at_hash: string;
  name: string;
  picture: string;
  given_name: string;
  family_name: string;
  locale: string;
  iat: number;
  exp: number;
}

interface AppleTokenPayload {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
  c_hash: string;
  email: string;
  email_verified: string;
  is_private_email: string;
  auth_time: number;
  nonce_supported: boolean;
}

let appleKeysCache: { keys: any[]; expiresAt: number } | null = null;

export async function validateGoogleToken(idToken: string): Promise<GoogleTokenPayload> {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      throw new Error('Google OAuth is not configured');
    }

    const response = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
      params: { id_token: idToken },
      timeout: 10000,
    });

    const payload = response.data as GoogleTokenPayload;

    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      throw new Error('Invalid token issuer');
    }

    if (payload.aud !== process.env.GOOGLE_CLIENT_ID) {
      throw new Error('Invalid token audience');
    }

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }

    return payload;
  } catch (error) {
    console.error('Google token validation error:', error);
    throw new Error('Invalid Google token');
  }
}

export async function validateAppleToken(identityToken: string): Promise<AppleTokenPayload> {
  try {
    const decodedToken = jwt.decode(identityToken, { complete: true });

    if (!decodedToken || typeof decodedToken === 'string') {
      throw new Error('Invalid token format');
    }

    if (!process.env.APPLE_CLIENT_ID) {
      throw new Error('Apple OAuth is not configured');
    }

    const key = await getApplePublicKey((decodedToken.header as jwt.JwtHeader).kid);
    const payload = jwt.verify(identityToken, key, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: process.env.APPLE_CLIENT_ID,
    }) as AppleTokenPayload;

    if (payload.iss !== 'https://appleid.apple.com') {
      throw new Error('Invalid token issuer');
    }

    if (payload.aud !== process.env.APPLE_CLIENT_ID) {
      throw new Error('Invalid token audience');
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('Token expired');
    }

    return payload;
  } catch (error) {
    console.error('Apple token validation error:', error);
    throw new Error('Invalid Apple token');
  }
}

async function getApplePublicKey(keyId?: string) {
  if (!keyId) {
    throw new Error('Apple token missing key identifier');
  }

  const now = Date.now();
  if (!appleKeysCache || appleKeysCache.expiresAt < now) {
    const response = await axios.get('https://appleid.apple.com/auth/keys', {
      timeout: 10000,
    });

    appleKeysCache = {
      keys: response.data.keys || [],
      expiresAt: now + 60 * 60 * 1000,
    };
  }

  const jwk = appleKeysCache.keys.find((item) => item.kid === keyId);
  if (!jwk) {
    throw new Error('Unable to find Apple public key');
  }

  return createPublicKey({ key: jwk, format: 'jwk' });
}

export function extractOAuthUserData(provider: 'google' | 'apple', payload: GoogleTokenPayload | AppleTokenPayload) {
  if (provider === 'google') {
    const googlePayload = payload as GoogleTokenPayload;
    return {
      oauthId: googlePayload.sub,
      email: googlePayload.email,
      name: googlePayload.name || `${googlePayload.given_name} ${googlePayload.family_name}`.trim(),
      photoUrl: googlePayload.picture,
      provider: 'google'
    };
  } else {
    const applePayload = payload as AppleTokenPayload;
    return {
      oauthId: applePayload.sub,
      email: applePayload.email,
      name: '', // Apple doesn't provide name in token, must be passed separately
      photoUrl: '',
      provider: 'apple'
    };
  }
}
