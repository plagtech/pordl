/**
 * pordl 🚪 — entry point
 * ---------------------------------------------------------------------------
 * Two products, one server:
 *   1. Regulatory read gateway (x402 + free tier)
 *   2. LLM proxy (subscription + free tier)
 */

import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { readRouter } from './read';
import { makePaymentMiddleware } from './payment';
import { watchRouter } from './watch';

// Proxy imports
import chatRoutes from './proxy/routes/chat';
import modelsRoutes from './proxy/routes/models';
import authRoutes from './proxy/routes/auth';
import { authMiddleware } from './proxy/middleware/auth';
import { usageMiddleware } from './proxy/middleware/usage';
import { moderationMiddleware } from './proxy/middleware/moderation';
import billingRoutes, { webhookHandler } from './proxy/routes/billing';
import savingsRoutes from './proxy/routes/savings';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.set('trust proxy', 1);

app.use(
  cors({
    origin: true,
    exposedHeaders: [
      'payment-required', 'payment-response', 'x-payment-response',
      'x-pordl-cached', 'x-pordl-provider', 'x-pordl-model',
      'x-pordl-complexity', 'x-pordl-routing', 'x-pordl-cost',
      'x-pordl-latency', 'x-pordl-savings',
      'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests',
      'x-ratelimit-reset-requests',
      'x-pordl-credits-limit', 'x-pordl-credits-used', 'x-pordl-credits-remaining',
    ],
  }),
);

app.post('/proxy/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));

// --- liveness + landing ----------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pordl' }));
app.get('/', (_req, res) =>
  res.json({
    service: 'pordl',
    tagline: 'the open-knowledge read gateway + smart LLM proxy',
    regulatory: {
      free: 'POST /free/read   { url, max_age? }   (rate-limited)',
      paid: 'POST /read        { url, max_age? }   (x402, ~$0.005/call)',
      watch: 'POST /watch      { url }              (change detection)',
    },
    proxy: {
      chat: 'POST /v1/chat/completions   (OpenAI-compatible, streaming supported)',
      models: 'GET  /v1/models',
      fiction: 'GET  /v1/models/recommended/fiction',
      streaming: 'Supported — works with any OpenAI-compatible client',
      providers: 'OpenAI, DeepSeek, Anthropic, Google',
      signup: 'POST /proxy/auth/signup',
      usage: 'GET  /proxy/auth/usage',
      tiers: {
        free: '$0/mo — 100K tokens/mo, 10 req/min',
        creator: '$4.99/mo — 1M tokens/mo, 30 req/min',
        creator_pro: '$9.99/mo — 5M tokens/mo, 60 req/min',
        creator_ultra: '$19.99/mo — 15M tokens/mo, 120 req/min',
      },
    },
    policy: 'All requests pass an automated content-safety check; prohibited content is refused.',
    legal: {
      terms: 'https://api.pordl.dev/terms',
      aup: 'https://api.pordl.dev/aup',
      privacy: 'https://api.pordl.dev/privacy',
    },
    docs: 'https://pordl.dev/docs',
  }),
);

// Clean URLs for docs + legal pages (files live in public/)
const pub = (file: string) => path.resolve(process.cwd(), 'public', file);
app.get('/docs', (_req, res) => res.sendFile(pub('docs.html')));
app.get('/terms', (_req, res) => res.sendFile(pub('terms.html')));
app.get('/aup', (_req, res) => res.sendFile(pub('aup.html')));
app.get('/privacy', (_req, res) => res.sendFile(pub('privacy.html')));

// === REGULATORY GATEWAY (existing — untouched) =============================
const freeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Free tier limit reached. Pay-per-call is unlimited: POST /read with x402.' },
});
app.use('/free/read', freeLimiter, readRouter);
app.use('/free/watch', freeLimiter, watchRouter);

const payment = makePaymentMiddleware();
if (payment) app.use(payment);
app.use('/read', readRouter);
app.use('/watch', watchRouter);

// === LLM PROXY (new) ======================================================
app.use('/proxy/auth', authRoutes);                              // signup, login, keys
// Order matters: auth → limits → CONTENT-SAFETY GATE → route. No request
// reaches a provider without passing moderation (the gate fails closed).
app.use('/v1/chat/completions', authMiddleware, usageMiddleware, moderationMiddleware, chatRoutes);
app.use('/v1/models', modelsRoutes);
app.use('/proxy/billing', authMiddleware, billingRoutes);
app.use('/proxy/billing', authMiddleware, savingsRoutes);

app.listen(PORT, () => console.log(`pordl listening on :${PORT}`));