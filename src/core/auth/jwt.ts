import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { env } from '../../config/env.js';

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const ISSUER = 'shaddai-api';
const AUDIENCE = 'shaddai-web';

export interface AccessClaims {
  sub: string; // userId
  sid: string; // familia de refresh (sesión)
  ver: number; // passwordChangedAt en segundos: cambiar la contraseña invalida los access emitidos
  imp?: string; // id del superadmin que está impersonando (sesión de soporte)
}

export interface TwoFactorChallengeClaims {
  sub: string;
  rm: boolean; // rememberMe elegido en el login
}

async function sign(payload: JWTPayload, typ: string, ttl: string) {
  return new SignJWT({ ...payload, typ })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

async function verify<T>(token: string, typ: string): Promise<(T & JWTPayload) | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return payload.typ === typ ? (payload as T & JWTPayload) : null;
  } catch {
    return null;
  }
}

export function signAccessToken(claims: AccessClaims, ttlMinutes = env.JWT_ACCESS_TTL_MIN) {
  return sign({ ...claims }, 'access', `${ttlMinutes}m`);
}

export function verifyAccessToken(token: string) {
  return verify<AccessClaims>(token, 'access');
}

export function signTwoFactorChallenge(claims: TwoFactorChallengeClaims) {
  return sign({ ...claims }, '2fa_challenge', '5m');
}

export function verifyTwoFactorChallenge(token: string) {
  return verify<TwoFactorChallengeClaims>(token, '2fa_challenge');
}
