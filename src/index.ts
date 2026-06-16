/**
 * pordl 🚪 — entry point
 * ---------------------------------------------------------------------------
 * Two tiers, one handler:
 *   POST /free/read   free, rate-limited per IP (top of funnel)
 *   POST /read        x402-metered per call (your pordl wallet)
 *   GET  /health      unmetered liveness for Railway
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { readRouter } from './read';
import { makePaymentMiddleware } from './payment';
import { watchRouter } from './watch';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Railway/Render sit behind a proxy — required so rate-limiting keys on the
// real client IP, not the proxy's.
app.set('trust proxy', 1);

app.use(
  cors({
    origin: true,
    exposedHeaders: ['payment-required', 'payment-response', 'x-payment-response'],
  }),
);
app.use(express.json({ limit: '32kb' }));

// --- liveness + landing ----------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, service: 'pordl' }));
app.get('/', (_req, res) =>
  res.json({
    service: 'pordl',
    tagline: 'the open-knowledge read gateway',
    endpoints: {
      free: 'POST /free/read   { url, max_age? }   (rate-limited)',
      paid: 'POST /read        { url, max_age? }   (x402, ~$0.005/call)',
    },
    docs: 'https://pordl.dev/docs',
  }),
);

// --- free tier: heavily rate-limited, no payment ---------------------------
const freeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10, // 10 free reads/min/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Free tier limit reached. Pay-per-call is unlimited: POST /read with x402.' },
});
app.use('/free/read', freeLimiter, readRouter);
app.use('/free/read', freeLimiter, readRouter);
app.use('/free/watch', freeLimiter, watchRouter);

// --- paid tier: x402-metered ----------------------------------------------
const payment = makePaymentMiddleware();
if (payment) app.use(payment);
app.use('/read', readRouter);
app.use('/watch', watchRouter);

app.listen(PORT, () => console.log(`pordl listening on :${PORT}`));
