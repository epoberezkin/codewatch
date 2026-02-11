// Spec: spec/auth.md
import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { getPool } from '../db';
import { config } from '../config';
import {
  getOAuthUrl,
  exchangeCodeForToken,
  getAuthenticatedUser,
} from '../services/github';
import { invalidateOwnershipCache } from '../services/ownership';

const router = Router();

// ---------- State signing (for returnTo parameter) ----------

// Spec: spec/auth.md#signState
function signState(payload: string): string {
  const hmac = crypto.createHmac('sha256', config.cookieSecret).update(payload).digest('hex');
  // base64url-encode: payload.hmac
  const encoded = Buffer.from(payload).toString('base64url');
  return `${encoded}.${hmac}`;
}

// Spec: spec/auth.md#verifyState
function verifyState(state: string): string | null {
  const dotIdx = state.indexOf('.');
  if (dotIdx === -1) return null;
  const encoded = state.substring(0, dotIdx);
  const hmac = state.substring(dotIdx + 1);
  const payload = Buffer.from(encoded, 'base64url').toString('utf-8');
  const expected = crypto.createHmac('sha256', config.cookieSecret).update(payload).digest('hex');
  const hmacBuf = Buffer.from(hmac);
  const expectedBuf = Buffer.from(expected);
  if (hmacBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(hmacBuf, expectedBuf)) return null;
  return payload;
}

// GET /auth/github — redirect to GitHub OAuth
router.get('/github', (req: Request, res: Response) => {
  const returnTo = req.query.returnTo as string | undefined;
  let state: string | undefined;
  if (returnTo) {
    // Only allow relative paths to prevent open redirect
    if (returnTo.startsWith('/') && !returnTo.startsWith('//')) {
      state = signState(returnTo);
    }
  }
  res.redirect(getOAuthUrl(state));
});

// GET /auth/github/callback — handle OAuth callback
router.get('/github/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send('Missing code parameter');
    return;
  }

  try {
    const { accessToken, scope } = await exchangeCodeForToken(code);
    const ghUser = await getAuthenticatedUser(accessToken);
    const pool = getPool();

    // Detect org scope
    const hasOrgScope = scope.split(',').some(s => s.trim() === 'read:org');

    // Upsert user
    const { rows: userRows } = await pool.query(
      `INSERT INTO users (github_id, github_username, github_type, avatar_url, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (github_id) DO UPDATE SET
         github_username = $2,
         github_type = $3,
         avatar_url = $4,
         last_seen_at = NOW()
       RETURNING id`,
      [ghUser.id, ghUser.login, ghUser.type, ghUser.avatar_url]
    );
    const userId = userRows[0].id;

    // Create session with has_org_scope
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO sessions (user_id, github_token, has_org_scope, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${config.sessionMaxAgeDays} days')
       RETURNING id`,
      [userId, accessToken, hasOrgScope]
    );
    const sessionId = sessionRows[0].id;

    // Invalidate ownership cache on re-auth (fresh token may have different scope)
    await invalidateOwnershipCache(pool, userId);

    // Set session cookie
    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: config.sessionMaxAgeDays * 24 * 60 * 60 * 1000,
    });

    // Check for returnTo state
    const stateParam = req.query.state as string | undefined;
    let redirectTo = '/';
    if (stateParam) {
      const returnTo = verifyState(stateParam);
      if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
        redirectTo = returnTo;
      }
    }

    res.redirect(redirectTo);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Authentication failed');
  }
});

// GET /auth/me — return current user info
router.get('/me', async (req: Request, res: Response) => {
  const sessionId = req.cookies?.session;
  if (!sessionId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT u.id, u.github_username, u.avatar_url, u.github_type, s.has_org_scope
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > NOW()`,
      [sessionId]
    );

    if (rows.length === 0) {
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    res.json({
      id: rows[0].id,
      username: rows[0].github_username,
      avatarUrl: rows[0].avatar_url,
      githubType: rows[0].github_type,
      hasOrgScope: rows[0].has_org_scope,
    });
  } catch (err) {
    console.error('Auth check error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /auth/logout — clear session
router.post('/logout', async (req: Request, res: Response) => {
  const sessionId = req.cookies?.session;
  if (sessionId) {
    try {
      const pool = getPool();
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    } catch (err) {
      console.error('Logout error:', err);
    }
  }
  res.clearCookie('session');
  res.json({ ok: true });
});

export default router;

// ---------- Middleware: require auth ----------

// Spec: spec/auth.md#requireAuth
export async function requireAuth(req: Request, res: Response, next: Function) {
  try {
    const sessionId = req.cookies?.session;
    if (!sessionId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT s.id as session_id, s.user_id, s.github_token, s.has_org_scope,
              u.github_username, u.github_type
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.expires_at > NOW()`,
      [sessionId]
    );

    if (rows.length === 0) {
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    // Attach user info to request
    (req as any).userId = rows[0].user_id;
    (req as any).githubToken = rows[0].github_token;
    (req as any).githubUsername = rows[0].github_username;
    (req as any).githubType = rows[0].github_type;
    (req as any).hasOrgScope = rows[0].has_org_scope;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}
