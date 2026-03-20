# MinutoFit Backend

Node.js/Express/TypeScript backend for the MinutoFit Fitness SaaS platform with JWT authentication, OAuth (Google + Apple), and Mercado Pago payment integration.

## Features

✅ JWT-based authentication (email/password)
✅ OAuth login (Google & Apple)
✅ User profile completion for OAuth users
✅ Subscription management (Free, Pro, Premium tiers)
✅ Mercado Pago integration
✅ Admin dashboard API
✅ PostgreSQL database
✅ TypeScript with strict mode
✅ CORS enabled
✅ Webhook handling for payments

## Prerequisites

- Node.js 18+
- PostgreSQL 12+
- Mercado Pago account (for production payments)
- Google OAuth credentials
- Apple OAuth credentials

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Database Setup

Create PostgreSQL database:

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database and user
CREATE DATABASE minutofitdb;
CREATE USER minutofit WITH PASSWORD 'your_secure_password';
ALTER ROLE minutofit SET client_encoding TO 'utf8';
ALTER ROLE minutofit SET default_transaction_isolation TO 'read committed';
GRANT ALL PRIVILEGES ON DATABASE minutofitdb TO minutofit;
```

### 3. Environment Configuration

Copy `.env.example` to `.env` and update with your values:

```bash
cp .env.example .env
```

**Critical env variables:**

```env
# Server
PORT=3000
NODE_ENV=development
DATABASE_URL=postgresql://minutofit:your_password@localhost:5432/minutofitdb
FRONTEND_URL=http://localhost:5173

# JWT (generate random strings)
JWT_SECRET=your_random_jwt_secret_key_here
JWT_REFRESH_SECRET=your_random_jwt_refresh_secret_here

# OAuth - Google (from Google Cloud Console)
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret

# OAuth - Apple (from Apple Developer)
APPLE_CLIENT_ID=com.minutofit.app
APPLE_TEAM_ID=your_apple_team_id
APPLE_KEY_ID=your_apple_key_id
APPLE_PRIVATE_KEY=your_apple_private_key_pem

# Mercado Pago (optional for development)
MERCADO_PAGO_ACCESS_TOKEN=your_mercado_pago_token
MERCADO_PAGO_PUBLIC_KEY=your_mercado_pago_public_key
```

### 4. Run Database Migration

```bash
npm run db:seed
```

This will:
- Create all database tables
- Seed subscription tiers (Free, Pro, Premium)
- Seed video tags

### 5. Start Development Server

```bash
npm run dev
```

The API will be available at `http://localhost:3000/api`

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register with email/password
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/oauth/google/callback` - Google OAuth login
- `POST /api/auth/oauth/apple/callback` - Apple OAuth login
- `GET /api/auth/me` - Get current user (requires JWT)
- `PATCH /api/auth/complete-profile` - Complete OAuth user profile
- `POST /api/auth/logout` - Logout

### Subscriptions

- `GET /api/subscriptions/tiers` - Get all subscription tiers
- `GET /api/subscriptions/current` - Get current user's subscription (requires JWT)
- `POST /api/subscriptions/create-checkout` - Create Mercado Pago checkout (requires JWT)
- `POST /api/subscriptions/cancel` - Cancel subscription (requires JWT)

### Admin

- `GET /api/admin/dashboard/metrics` - Dashboard metrics (admin only)
- `GET /api/admin/users` - List all users (admin only)
- `PATCH /api/admin/users/:id` - Update user (admin only)
- `POST /api/admin/users/:id/subscription` - Adjust user subscription (admin only)
- `GET /api/admin/subscriptions/report` - Subscription analytics (admin only)
- `GET /api/admin/videos/analytics` - Video analytics (admin only)

### Webhooks

- `POST /api/webhooks/mercadopago` - Handle Mercado Pago webhooks

## OAuth Setup

### Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new project
3. Enable Google+ API
4. Create OAuth 2.0 credentials (Web application)
5. Add authorized redirect URIs:
   - `http://localhost:5173/auth/callback`
   - `https://yourdomain.com/auth/callback`
6. Copy Client ID and Client Secret to `.env`

### Apple OAuth

1. Go to [Apple Developer Portal](https://developer.apple.com/)
2. Create App ID for your bundle ID
3. Create Service ID
4. Create Sign in with Apple credential
5. Configure return URLs
6. Generate private key
7. Copy Team ID, Key ID, and download private key to `.env`

## Database Schema

### Main Tables

- `users` - User accounts with OAuth fields
- `user_subscriptions` - Active subscriptions per user
- `subscription_tiers` - Subscription tier definitions
- `payments` - Payment ledger
- `videos` - Video content
- `tags` - Video tags
- `video_tags` - Video-tag relationships
- `video_access` - Subscription tier access control for videos

## Scripts

```bash
# Development with auto-reload
npm run dev

# Build TypeScript
npm run build

# Start production server
npm start

# Seed database
npm run db:seed

# Lint code
npm run lint

# Run tests
npm test
```

## Testing

### Health Check

```bash
curl http://localhost:3000/api/health
```

### Register User

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "name": "John Doe"
  }'
```

### Login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123"
  }'
```

### Get Current User

```bash
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Get Subscription Tiers

```bash
curl http://localhost:3000/api/subscriptions/tiers
```

## Errors & Troubleshooting

### PostgreSQL Connection Error

- Verify DATABASE_URL is correct
- Ensure PostgreSQL is running: `psql -U postgres`
- Check database user exists and has password set

### JWT Token Expired

- Frontend should use refresh token to get new access token
- Token expiry configured via JWT_EXPIRY env var (default 1h)

### OAuth Token Invalid

- Verify correct credentials in .env
- Check token hasn't expired
- Validate token signature matches issuer

### Mercado Pago Webhook Not Received

- Verify webhook URL in Mercado Pago dashboard
- Ensure FRONTEND_URL is publicly accessible (not localhost for production)
- Check webhook logs in Mercado Pago dashboard

## Deployment

### Heroku

```bash
heroku login
heroku create minutofit-backend
heroku addons:create heroku-postgresql:standard-0
git push heroku main
heroku run npm run db:seed
```

### AWS Lambda + RDS

- Create RDS PostgreSQL instance
- Deploy as Lambda function with API Gateway
- Store DB credentials in AWS Secrets Manager
- Use environment variables for secure secrets

### Docker

```dockerfile
FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

## License

MIT

## Support

For issues or questions, open an issue on GitHub or contact support.
