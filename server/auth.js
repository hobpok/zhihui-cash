// No development identity/header bypass is present in this production module.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError } from './errors.js';

export function accessConfig(env) {
  const issuer = env.ACCESS_TEAM_DOMAIN;
  if (typeof issuer !== 'string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer) ||
      typeof env.ACCESS_AUD !== 'string' || !/^[a-f0-9]{64}$/.test(env.ACCESS_AUD)) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED');
  }
  let origin;
  try { origin = new URL(env.APP_ORIGIN); } catch { throw new HttpError(503, 'AUTH_NOT_CONFIGURED'); }
  if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN || origin.username || origin.password) {
    throw new HttpError(503, 'AUTH_NOT_CONFIGURED');
  }
  return { issuer, audience: env.ACCESS_AUD, origin: origin.origin };
}

// The optional resolver factory is a code-level seam for signed-token tests;
// production only calls createAccessVerifier() with no arguments.
export function createAccessVerifier(makeResolver = url => createRemoteJWKSet(url, {
  timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000,
})) {
  let cachedIssuer, resolver;
  return async function verifyAccess(request, env) {
    const config = accessConfig(env);
    if (new URL(request.url).origin !== config.origin) throw new HttpError(403, 'ORIGIN_NOT_ALLOWED');
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16384) throw new HttpError(401, 'AUTH_REQUIRED');
    if (cachedIssuer !== config.issuer) {
      resolver = makeResolver(new URL(`${config.issuer}/cdn-cgi/access/certs`));
      cachedIssuer = config.issuer;
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(token, resolver, {
        issuer: config.issuer, audience: config.audience, algorithms: ['RS256'],
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'email', 'type'], clockTolerance: 0,
      }));
    } catch (error) {
      if (error.code === 'ERR_JWKS_TIMEOUT' || error instanceof TypeError) throw new HttpError(503, 'AUTH_UNAVAILABLE');
      throw new HttpError(401, 'INVALID_SESSION');
    }
    if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 256 ||
        typeof payload.email !== 'string' || payload.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
        !Number.isSafeInteger(payload.iat) || payload.iat > Math.floor(Date.now() / 1000) || payload.exp <= payload.iat) {
      throw new HttpError(401, 'INVALID_SESSION');
    }
    return Object.freeze({ issuer: payload.iss, subject: payload.sub, email: payload.email.toLowerCase() });
  };
}

export const verifyAccess = createAccessVerifier();
