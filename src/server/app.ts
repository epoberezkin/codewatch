import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import { gateMiddleware, gateHandler } from './middleware/gate';
import authRoutes from './routes/auth';
import apiRoutes from './routes/api';

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(cookieParser(config.cookieSecret));

  // Static files (before gate — all static assets are always accessible)
  const publicDir = path.join(__dirname, '..', '..', 'public');
  app.use(express.static(publicDir));

  // Gate: password-protected access for pre-launch testing
  app.post('/gate', gateHandler);
  app.use(gateMiddleware);

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
