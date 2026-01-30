import { Router, Request, Response } from 'express';
import { getPool } from '../db';
import { config } from '../config';
import {
  getOAuthUrl,
  exchangeCodeForToken,
  getAuthenticatedUser,
} from '../services/github';

const router = Router();

// GET /auth/github — redirect to GitHub OAuth
router.get('/github', (_req: Request, res: Response) => {
  res.redirect(getOAuthUrl());
});

// GET /auth/github/callback — handle OAuth callback
router.get('/github/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send('Missing code parameter');
    return;
  }

  try {
    const token = await exchangeCodeForToken(code);
    const ghUser = await getAuthenticatedUser(token);
    const pool = getPool();

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

    // Create session
    const { rows: sessionRows } = await pool.query(
      `INSERT INTO sessions (user_id, github_token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '${config.sessionMaxAgeDays} days')
       RETURNING id`,
      [userId, token]
    );
    const sessionId = sessionRows[0].id;

    // Set session cookie
    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: config.sessionMaxAgeDays * 24 * 60 * 60 * 1000,
    });

    res.redirect('/');
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
      `SELECT u.id, u.github_username, u.avatar_url, u.github_type
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

export async function requireAuth(req: Request, res: Response, next: Function) {
  const sessionId = req.cookies?.session;
  if (!sessionId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT s.id as session_id, s.user_id, s.github_token,
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
  next();
}
