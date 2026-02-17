// Spec: spec/architecture.md#express-app
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import { gateMiddleware, gateHandler } from './middleware/gate';
import authRoutes from './routes/auth';
import apiRoutes from './routes/api';

// Spec: spec/architecture.md#createApp
export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(cookieParser(config.cookieSecret));

  // Gate: password-protected access for pre-launch testing (before static files so HTML pages are gated)
  app.post('/gate', gateHandler);
  app.use(gateMiddleware);

  // Static files (after gate — gate bypasses CSS/JS/images/fonts via extension check)
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Auth routes
  app.use('/auth', authRoutes);

  // API routes
  app.use('/api', apiRoutes);

  return app;
}
