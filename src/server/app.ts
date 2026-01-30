import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import authRoutes from './routes/auth';
import apiRoutes from './routes/api';

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(cookieParser(config.cookieSecret));

  // Static files
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
