import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import authRoutes from './routes/auth';
import subscriptionRoutes from './routes/subscriptions';
import webhookRoutes from './routes/webhooks';
import adminRoutes from './routes/admin';
import gamificationRoutes from './routes/gamification';
import personalRoutes from './routes/personal';

dotenv.config();

const app = express();

function parseAllowedOrigins() {
  const envOrigins = [process.env.FRONTEND_URL, process.env.FRONTEND_URLS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((origin) => origin.trim())
    .filter(Boolean);

  return Array.from(
    new Set([
      ...envOrigins,
      'http://localhost:5173',
      'http://localhost:3000',
    ])
  );
}

const allowedOrigins = parseAllowedOrigins();
const vercelPreviewPattern = /^https:\/\/[a-z0-9-]+\.vercel\.app$/i;

// Middleware
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin) || vercelPreviewPattern.test(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/gamification', gamificationRoutes);
app.use('/api/personal', personalRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Backend is running' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// Error handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  console.log(`✅ MinutoFit Backend running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Allowed Frontend Origins: ${allowedOrigins.join(', ')}`);
});
