/**
 * payment.ts — x402 metering for the paid /read route (your pordl wallet).
 * ---------------------------------------------------------------------------
 * Mirrors the standard @x402/express v2 setup. If your Spraay facilitator/CDP
 * config differs in any detail, mirror THAT here — it's your known-good path.
 *
 * Local testing (free): set X402_NETWORK=eip155:84532 and
 *   FACILITATOR_URL=https://x402.org/facilitator, fund a Base-Sepolia wallet.
 * Mainnet: the CDP facilitator settles USDC fee-free on Base; it expects your
 *   CDP API credentials (configure exactly as Spraay does).
 *
 * If PAY_TO_ADDRESS is unset, the server boots UNMETERED so you can run it
 * locally before wiring a wallet.
 */

import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { RequestHandler } from 'express';

export function makePaymentMiddleware(): RequestHandler | null {
  const payTo = process.env.PAY_TO_ADDRESS;
  const network = (process.env.X402_NETWORK ?? 'eip155:8453') as `${string}:${string}`; // Base mainnet (CAIP-2)
  const facilitatorUrl = process.env.FACILITATOR_URL ?? 'https://api.cdp.coinbase.com/platform/v2/x402';
  const price = process.env.PRICE ?? '$0.005';

  if (!payTo) {
    console.warn('[pordl] PAY_TO_ADDRESS not set — running UNMETERED (dev mode). Set it to enable x402 billing.');
    return null;
  }

  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(network, new ExactEvmScheme());

  return paymentMiddleware(
    {
      'POST /read': {
        accepts: [{ scheme: 'exact', price, network, payTo: payTo as `0x${string}` }],
        description: 'pordl — read a permitted open-content source as clean markdown',
        mimeType: 'application/json',
      },
    },
    resourceServer,
  );
}
