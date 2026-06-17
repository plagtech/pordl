/**
 * src/proxy/routes/billing.ts
 * ────────────────────────────
 * POST /proxy/billing/checkout  → Stripe checkout URL
 * POST /proxy/billing/portal    → Stripe customer portal URL
 *
 * Webhook handler is exported separately — mounted in index.ts
 * with express.raw() BEFORE express.json().
 */

import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
} from '../services/billing';

// ── Supabase client for user lookups ───────────────────

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || '',
);

const router = Router();

// ── Helper: resolve API key → user record ──────────────

async function resolveUser(req: Request) {
  const apiKey = req.headers.authorization?.replace('Bearer ', '');
  if (!apiKey) return null;

  const { data: keyRow } = await supabase
    .from('api_keys')
    .select('user_id')
    .eq('key', apiKey)
    .single();

  if (!keyRow) return null;

  const { data: user } = await supabase
    .from('users')
    .select('id, email, stripe_customer_id')
    .eq('id', keyRow.user_id)
    .single();

  return user;
}

// ── POST /proxy/billing/checkout ───────────────────────
// Body: { "tier": "starter" | "pro" | "scale" }
// Auth: Bearer pd_live_xxx

router.post('/checkout', async (req: Request, res: Response) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });

  const { tier } = req.body;
  if (!tier || !['starter', 'pro', 'scale'].includes(tier)) {
    return res.status(400).json({
      error: 'Invalid tier. Options: starter, pro, scale',
    });
  }

  try {
    const url = await createCheckoutSession(user.id, user.email, tier);
    if (!url) return res.status(500).json({ error: 'Checkout session failed' });
    res.json({ url, tier });
  } catch (err: any) {
    console.error('[Billing] checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /proxy/billing/portal ─────────────────────────
// Auth: Bearer pd_live_xxx

router.post('/portal', async (req: Request, res: Response) => {
  const user = await resolveUser(req);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });

  if (!user.stripe_customer_id) {
    return res.status(400).json({
      error: 'No active subscription. Subscribe first via /proxy/billing/checkout',
    });
  }

  try {
    const url = await createPortalSession(user.stripe_customer_id);
    res.json({ url });
  } catch (err: any) {
    console.error('[Billing] portal error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

// ── Webhook handler (mounted separately in index.ts) ───
// Needs raw body, no auth — Stripe validates via signature

export async function webhookHandler(req: Request, res: Response) {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) return res.status(400).send('Missing stripe-signature');

  try {
    await handleWebhookEvent(req.body, sig);
    res.json({ received: true });
  } catch (err: any) {
    console.error('[Billing] webhook error:', err.message);
    res.status(400).send(`Webhook error: ${err.message}`);
  }
}
