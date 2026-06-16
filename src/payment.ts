/**
 * payment.ts — x402 metering for the paid /read route (your pordl wallet).
 * ---------------------------------------------------------------------------
 * Matches the standard @x402/express v2 + @coinbase/x402 mainnet pattern (the
 * same one Spraay runs). If your Spraay facilitator setup differs, mirror it.
 *
 * MAINNET (real USDC on Base):
 *   Set CDP_API_KEY_ID + CDP_API_KEY_SECRET (from Coinbase Developer Platform —
 *   the same creds Spraay uses) and X402_NETWORK=eip155:8453. The facilitator
 *   becomes AUTHENTICATED and can actually verify + settle.
 *
 * TESTNET (Base Sepolia, no real funds):
 *   Leave the CDP creds unset and set X402_NETWORK=eip155:84532. Falls back to
 *   the public x402.org facilitator, which needs no auth.
 *
 * The startup log tells you which mode you're in — check it after deploy.
 */

import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import type { RequestHandler } from 'express';

export function makePaymentMiddleware(): RequestHandler | null {
  const payTo = process.env.PAY_TO_ADDRESS;
  const network = (process.env.X402_NETWORK ?? 'eip155:8453') as `${string}:${string}`;
  const price = process.env.PRICE ?? '$0.005';
  const cdpKeyId = process.env.CDP_API_KEY_ID;
  const cdpKeySecret = process.env.CDP_API_KEY_SECRET;

  if (!payTo) {
    console.warn('[pordl] PAY_TO_ADDRESS not set — running UNMETERED (dev mode). Set it to enable x402 billing.');
    return null;
  }

  // Mainnet settlement REQUIRES an authenticated CDP facilitator. Without CDP
  // creds we fall back to the public testnet facilitator (Sepolia only).
  let facilitatorConfig: unknown;
  if (cdpKeyId && cdpKeySecret) {
    facilitatorConfig = createFacilitatorConfig(cdpKeyId, cdpKeySecret);
    console.log(`[pordl] Authenticated CDP facilitator active — mainnet-capable. network=${network}`);
  } else {
    const url = process.env.FACILITATOR_URL ?? 'https://x402.org/facilitator';
    facilitatorConfig = { url };
    console.warn(`[pordl] No CDP credentials set. Using unauthenticated facilitator ${url}. ` +
      `Real mainnet settlement will NOT work — testnet (eip155:84532) only. network=${network}`);
  }

  const facilitator = new HTTPFacilitatorClient(facilitatorConfig as never);
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());

  return paymentMiddleware(
  {
    'POST /read': {
      accepts: [{ scheme: 'exact', price, network, payTo: payTo as `0x${string}` }],
      description: 'pordl — read a permitted open-content source as clean markdown',
      mimeType: 'application/json',
    },
    'POST /watch': {
      accepts: [{ scheme: 'exact', price: '$0.02', network, payTo: payTo as `0x${string}` }],
      description: 'pordl — detect what changed on a regulatory source since last check',
      mimeType: 'application/json',
    },
  },
  resourceServer,
);
}
