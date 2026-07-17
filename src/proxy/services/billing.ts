/**
 * src/proxy/services/billing.ts
 * ──────────────────────────────
 * Stripe billing: checkout sessions, portal, webhook handling.
 * Reads price IDs from env via proxy config.
 */

import Stripe from 'stripe';
import { config } from '../config';
import { createClient } from '@supabase/supabase-js';
import { recordTopup } from '../db/supabase';

// ── Clients ────────────────────────────────────────────

const stripe = new Stripe(config.stripe.secretKey);

const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
);

// ── Tier ↔ Price mappings ──────────────────────────────

const TIER_PRICES: Record<string, string> = {
  creator:       config.stripe.prices.creator,
  creator_pro:   config.stripe.prices.creator_pro,
  creator_ultra: config.stripe.prices.creator_ultra,
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

// ── One-time credit top-up (explicit purchase — never auto-charged) ──

export async function createTopupSession(
  userId: string,
  email: string,
): Promise<string> {
  if (!config.topup.stripePrice) {
    throw new Error('Top-ups not configured (STRIPE_PRICE_TOPUP unset)');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment', // one-time — no subscription, no stored auto-charge
    customer_email: email,
    line_items: [{ price: config.topup.stripePrice, quantity: 1 }],
    success_url: 'https://api.pordl.dev/?topup=success',
    cancel_url:  'https://api.pordl.dev/?topup=cancelled',
    metadata: {
      user_id: userId,
      type: 'topup',
      credits: String(config.topup.credits),
    },
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
      const customerId = session.customer as string;

      // One-time credit top-up (explicit purchase)
      if (session.metadata?.type === 'topup') {
        const credits = parseInt(session.metadata?.credits || '0');
        if (userId && credits > 0) {
          await recordTopup(userId, credits, session.id);
          console.log(`[Billing] ➕ ${userId} topped up ${credits} credits`);
        }
        break;
      }

      const tier = session.metadata?.tier;
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
    .update({ tier: 'free' })
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
