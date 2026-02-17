// Spec: spec/auth.md#gate
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { config } from '../config';

const GATE_COOKIE = 'gate';
const GATE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATIC_ASSET_EXT = /\.(css|js|svg|png|jpg|jpeg|gif|ico|woff2?|ttf|eot|map|webp|avif)$/i;

// Spec: spec/auth.md#hmacGateValue
function hmacGateValue(password: string): string {
  return crypto
    .createHmac('sha256', config.cookieSecret)
    .update(password)
    .digest('hex');
}

// Spec: spec/auth.md#gateMiddleware
export function gateMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Gate disabled when no password configured
  if (!config.gatePassword) {
    next();
    return;
  }

  // Allow health check, gate page itself, and static assets (CSS, JS, images, fonts)
  if (req.path === '/api/health' || req.path === '/gate.html' || STATIC_ASSET_EXT.test(req.path)) {
    next();
    return;
  }

  // Check signed gate cookie
  const cookieValue = req.signedCookies?.[GATE_COOKIE];
  if (cookieValue && cookieValue === hmacGateValue(config.gatePassword)) {
    next();
    return;
  }

  // Redirect to gate page
  res.redirect(302, '/gate.html');
}

// Spec: spec/auth.md#gateHandler
export function gateHandler(req: Request, res: Response): void {
  if (!config.gatePassword) {
    res.redirect('/');
    return;
  }

  const { password } = req.body;
  if (!password || password !== config.gatePassword) {
    res.status(401).json({ error: 'Wrong password' });
    return;
  }

  res.cookie(GATE_COOKIE, hmacGateValue(config.gatePassword), {
    signed: true,
    httpOnly: true,
    maxAge: GATE_MAX_AGE,
    sameSite: 'lax',
  });

  res.json({ ok: true });
}
