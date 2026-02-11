// Spec: spec/config.md
// Spec: spec/config.md#config
export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/codewatch',
  reposDir: process.env.REPOS_DIR || './repos',
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:3000/auth/github/callback',
  },
  anthropicServiceKey: process.env.ANTHROPIC_SERVICE_KEY || '',
  cookieSecret: process.env.COOKIE_SECRET || 'dev-secret-change-in-production',
  gatePassword: process.env.GATE_PASSWORD || '',
  sessionMaxAgeDays: 14,
};
