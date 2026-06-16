/**
 * Stripe billing integration.
 *
 * Handles:
 * - Creating checkout sessions for tier upgrades
 * - Webhook processing for subscription events
 * - Customer portal for self-serve management
 */

import Stripe from "stripe";
import { config } from "../config";
import { updateUserTier } from "../db/supabase";

const stripe = new Stripe(config.stripe.secretKey);

// ── Tier → Stripe Price mapping ────────────────────────

const TIER_PRICE_MAP: Record<string, string> = {
  starter: config.stripe.prices.starter,
  pro: config.stripe.prices.pro,
  scale: config.stripe.prices.scale,
};

const PRICE_TIER_MAP: Record<string, string> = {};
for (const [tier, priceId] of Object.entries(TIER_PRICE_MAP)) {
  if (priceId) PRICE_TIER_MAP[priceId] = tier;
}

// ── Create checkout session ────────────────────────────

export async function createCheckoutSession(
  userId: string,
  email: string,
  tier: string
): Promise<string> {
  const priceId = TIER_PRICE_MAP[tier];
  if (!priceId) throw new Error(`No Stripe price configured for tier: ${tier}`);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: "https://pordl.dev/dashboard?upgraded=true",
    cancel_url: "https://pordl.dev/pricing",
    metadata: { user_id: userId, tier },
  });

  return session.url || "";
}

// ── Create customer portal session ─────────────────────

export async function createPortalSession(
  stripeCustomerId: string
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: "https://pordl.dev/dashboard",
  });

  return session.url;
}

// ── Handle webhook events ──────────────────────────────

export async function handleWebhookEvent(
  body: Buffer,
  signature: string
): Promise<void> {
  const event = stripe.webhooks.constructEvent(
    body,
    signature,
    config.stripe.webhookSecret
  );

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id;
      const tier = session.metadata?.tier;
      const customerId = session.customer as string;

      if (userId && tier) {
        await updateUserTier(userId, tier, customerId);
        console.log(`[Billing] User ${userId} upgraded to ${tier}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;

      // Downgrade to free tier
      // TODO: Look up user by stripe_customer_id and downgrade
      console.log(`[Billing] Subscription cancelled for customer ${customerId}`);
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const priceId = subscription.items.data[0]?.price?.id;
      const tier = priceId ? PRICE_TIER_MAP[priceId] : null;
      const customerId = subscription.customer as string;

      if (tier) {
        console.log(`[Billing] Subscription updated for ${customerId}: ${tier}`);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      console.warn(
        `[Billing] Payment failed for customer ${invoice.customer}`
      );
      // TODO: Send email notification, grace period logic
      break;
    }

    default:
      // Unhandled event types are fine
      break;
  }
}
