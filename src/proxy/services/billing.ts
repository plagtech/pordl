/**
 * src/proxy/services/billing.ts
 * ──────────────────────────────
 * Stripe billing: checkout sessions, portal, webhook handling.
 * Reads price IDs from env via proxy config.
 */

import Stripe from 'stripe';
import { config } from '../config';
import { createClient } from '@supabase/supabase-js';

// ── Clients ────────────────────────────────────────────

const stripe = new Stripe(config.stripe.secretKey);

const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
);

// ── Tier ↔ Price mappings ──────────────────────────────

const TIER_PRICES: Record<string, string> = {
  starter: config.stripe.prices.starter,
  pro:     config.stripe.prices.pro,
  scale:   config.stripe.prices.scale,
};

const PRICE_TIERS: Record<string, string> = {};
for (const [tier, priceId] of Object.entries(TIER_PRICES)) {
  if (priceId) PRICE_TIERS[priceId] = tier;
}

// ── Create checkout session ────────────────────────────

export async function createCheckoutSession(
  userId: string,
  email: string,
  tier: string,
): Promise<string> {
  const priceId = TIER_PRICES[tier];
  if (!priceId) throw new Error(`No Stripe price for tier: ${tier}`);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: 'https://api.pordl.dev/?upgraded=true',
    cancel_url:  'https://api.pordl.dev/?cancelled=true',
    metadata: { user_id: userId, tier },
  });

  return session.url || '';
}

// ── Customer portal (manage/cancel subscription) ───────

export async function createPortalSession(
  stripeCustomerId: string,
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: 'https://api.pordl.dev/',
  });
  return session.url;
}

// ── Webhook event handler ──────────────────────────────

export async function handleWebhookEvent(
  rawBody: Buffer,
  signature: string,
): Promise<void> {
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signature,
    config.stripe.webhookSecret,
  );

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId     = session.metadata?.user_id;
      const tier       = session.metadata?.tier;
      const customerId = session.customer as string;

      if (userId && tier) {
        await updateUserTier(userId, tier, customerId);
        console.log(`[Billing] ✅ ${userId} → ${tier}`);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = sub.customer as string;
      await downgradeByCustomer(customerId);
      console.log(`[Billing] ⬇️  cancelled: ${customerId}`);
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const priceId = sub.items.data[0]?.price?.id;
      const tier = priceId ? PRICE_TIERS[priceId] : null;
      if (tier) {
        const customerId = sub.customer as string;
        await updateTierByCustomer(customerId, tier);
        console.log(`[Billing] 🔄 ${customerId} → ${tier}`);
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      console.warn(`[Billing] ❌ payment failed: ${invoice.customer}`);
      break;
    }

    default:
      break;
  }
}

// ── Supabase helpers ───────────────────────────────────

async function updateUserTier(
  userId: string,
  tier: string,
  stripeCustomerId: string,
) {
  const { error } = await supabase
    .from('users')
    .update({ tier, stripe_customer_id: stripeCustomerId })
    .eq('id', userId);

  if (error) console.error('[Billing] updateUserTier failed:', error.message);
}

async function downgradeByCustomer(stripeCustomerId: string) {
  const { error } = await supabase
    .from('users')
    .update({ tier: 'starter' })
    .eq('stripe_customer_id', stripeCustomerId);

  if (error) console.error('[Billing] downgrade failed:', error.message);
}

async function updateTierByCustomer(stripeCustomerId: string, tier: string) {
  const { error } = await supabase
    .from('users')
    .update({ tier })
    .eq('stripe_customer_id', stripeCustomerId);

  if (error) console.error('[Billing] updateTierByCustomer failed:', error.message);
}
