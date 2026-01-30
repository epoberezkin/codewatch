import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export interface TestUser {
  id: string;
  githubId: number;
  username: string;
}

export interface TestSession {
  sessionId: string;
  userId: string;
  cookie: string;
}

export async function createTestUser(pool: Pool, overrides?: Partial<{ githubId: number; username: string; githubType: string }>): Promise<TestUser> {
  const githubId = overrides?.githubId ?? Math.floor(Math.random() * 1000000);
  const username = overrides?.username ?? `testuser_${githubId}`;
  const githubType = overrides?.githubType ?? 'User';

  const { rows } = await pool.query(
    `INSERT INTO users (github_id, github_username, github_type)
     VALUES ($1, $2, $3)
     RETURNING id, github_id, github_username`,
    [githubId, username, githubType]
  );

  return {
    id: rows[0].id,
    githubId: rows[0].github_id,
    username: rows[0].github_username,
  };
}

export async function createTestSession(pool: Pool, userId?: string): Promise<TestSession> {
  let uid = userId;
  if (!uid) {
    const user = await createTestUser(pool);
    uid = user.id;
  }

  const { rows } = await pool.query(
    `INSERT INTO sessions (user_id, github_token)
     VALUES ($1, $2)
     RETURNING id`,
    [uid, 'test-github-token-' + uuidv4()]
  );

  const sessionId = rows[0].id;
  return {
    sessionId,
    userId: uid,
    cookie: `session=${sessionId}`,
  };
}

export async function authenticatedFetch(
  url: string,
  sessionCookie: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Cookie: sessionCookie,
    },
  });
}
