/**
 * src/proxy/routes/billing.ts
 * ────────────────────────────
 * POST /proxy/billing/checkout  → Stripe checkout URL
 * POST /proxy/billing/portal    → Stripe customer portal URL
 *
 * These routes sit behind authMiddleware (mounted in index.ts),
 * so req.auth.user and req.auth.apiKey are already populated.
 *
 * Webhook handler is exported separately — mounted in index.ts
 * with express.raw() BEFORE express.json().
 */

import { Router, Request, Response } from 'express';
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
} from '../services/billing';

const router = Router();

// ── POST /proxy/billing/checkout ───────────────────────
// Body: { "tier": "creator" | "creator_pro" | "creator_ultra" }
// Auth: Bearer pd_live_xxx (handled by authMiddleware)

router.post('/checkout', async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { tier } = req.body;
  if (!tier || !['creator', 'creator_pro', 'creator_ultra'].includes(tier)) {
    return res.status(400).json({
      error: 'Invalid tier. Options: creator, creator_pro, creator_ultra',
    });
  }

  try {
    const url = await createCheckoutSession(
      req.auth.user.id,
      req.auth.user.email,
      tier,
    );
    if (!url) return res.status(500).json({ error: 'Checkout session failed' });
    res.json({ url, tier });
  } catch (err: any) {
    console.error('[Billing] checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /proxy/billing/portal ─────────────────────────
// Auth: Bearer pd_live_xxx (handled by authMiddleware)

router.post('/portal', async (req: Request, res: Response) => {
  if (!req.auth) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const customerId = (req.auth.user as any).stripe_customer_id;
  if (!customerId) {
    return res.status(400).json({
      error: 'No active subscription. Subscribe first via /proxy/billing/checkout',
    });
  }

  try {
    const url = await createPortalSession(customerId);
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
