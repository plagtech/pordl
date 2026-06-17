/**
 * PORDL Savings API
 * 
 * GET /proxy/billing/savings
 *   → Authenticated. Returns savings breakdown for the calling user.
 *
 * GET /proxy/billing/savings/summary  (public — for Show HN hero stat)
 *   → Aggregate savings across all users (no PII).
 *
 * Drop into src/proxy/ alongside billing.ts and mount in index.ts:
 *   import savingsRouter from './savings';
 *   app.use('/proxy/billing', savingsRouter);
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

const router = Router();

// ── Pricing table ($ per 1K tokens) ─────────────────────────────────────────
// Retail OpenAI prices. PORDL routes to the cheapest adequate model, so:
//   savings = (gpt-4o retail cost − what PORDL actually charged) per request.
// Update when OpenAI changes pricing.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o':           { input: 0.0025,  output: 0.0100 },
  'gpt-4o-mini':      { input: 0.00015, output: 0.0006 },
  'gpt-4.1':          { input: 0.002,   output: 0.008  },
  'gpt-4.1-mini':     { input: 0.0004,  output: 0.0016 },
  'gpt-4.1-nano':     { input: 0.0001,  output: 0.0004 },
  'gpt-3.5-turbo':    { input: 0.0005,  output: 0.0015 },
  'gpt-5.4':          { input: 0.003,   output: 0.012  },
};

// The "expensive default" users would be paying without PORDL
const BASELINE_MODEL = 'gpt-4o';

// ── Matches your actual Supabase usage_logs schema ──────────────────────────
interface UsageRow {
  id: string;
  user_id: string;
  api_key_id: string;
  provider: string;        // e.g. "openai"
  model: string;           // e.g. "gpt-4o-mini"
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;        // what PORDL charged
  cached: boolean;
  latency_ms: number;
  routing_mode: string | null;
  created_at: string;
}

interface SavingsBreakdown {
  period: string;
  total_requests: number;
  total_tokens: number;
  actual_cost: number;
  baseline_cost: number;
  saved: number;
  savings_pct: number;
  cache_hit_rate: number;
  avg_latency_ms: number;
  by_model: Record<string, {
    requests: number;
    tokens: number;
    actual_cost: number;
    baseline_cost: number;
    saved: number;
    cached_count: number;
    avg_latency_ms: number;
  }>;
  daily: Array<{
    date: string;
    requests: number;
    actual_cost: number;
    baseline_cost: number;
    saved: number;
    cached: number;
  }>;
}

function calcBaselineCost(inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[BASELINE_MODEL];
  return (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output;
}

function buildSavings(rows: UsageRow[], period: string): SavingsBreakdown {
  const byModel: SavingsBreakdown['by_model'] = {};
  const dailyMap: Record<string, {
    requests: number; actual_cost: number; baseline_cost: number; saved: number; cached: number;
  }> = {};

  let totalRequests = 0;
  let totalTokens = 0;
  let actualCost = 0;
  let baselineCost = 0;
  let cachedCount = 0;
  let totalLatency = 0;

  for (const row of rows) {
    const tokens = (row.input_tokens || 0) + (row.output_tokens || 0);
    const rowBaseline = calcBaselineCost(row.input_tokens || 0, row.output_tokens || 0);
    const rowActual = row.cost_usd || 0;
    const rowSaved = Math.max(0, rowBaseline - rowActual);

    totalRequests++;
    totalTokens += tokens;
    actualCost += rowActual;
    baselineCost += rowBaseline;
    if (row.cached) cachedCount++;
    totalLatency += row.latency_ms || 0;

    // By model
    const model = row.model || 'unknown';
    if (!byModel[model]) {
      byModel[model] = {
        requests: 0, tokens: 0, actual_cost: 0, baseline_cost: 0,
        saved: 0, cached_count: 0, avg_latency_ms: 0,
      };
    }
    byModel[model].requests++;
    byModel[model].tokens += tokens;
    byModel[model].actual_cost += rowActual;
    byModel[model].baseline_cost += rowBaseline;
    byModel[model].saved += rowSaved;
    if (row.cached) byModel[model].cached_count++;
    byModel[model].avg_latency_ms += row.latency_ms || 0;

    // Daily
    const date = row.created_at?.slice(0, 10) || 'unknown';
    if (!dailyMap[date]) {
      dailyMap[date] = { requests: 0, actual_cost: 0, baseline_cost: 0, saved: 0, cached: 0 };
    }
    dailyMap[date].requests++;
    dailyMap[date].actual_cost += rowActual;
    dailyMap[date].baseline_cost += rowBaseline;
    dailyMap[date].saved += rowSaved;
    if (row.cached) dailyMap[date].cached++;
  }

  // Compute averages for by_model
  for (const m of Object.values(byModel)) {
    m.avg_latency_ms = m.requests > 0 ? Math.round(m.avg_latency_ms / m.requests) : 0;
  }

  const saved = Math.max(0, baselineCost - actualCost);
  const savingsPct = baselineCost > 0 ? (saved / baselineCost) * 100 : 0;

  const daily = Object.entries(dailyMap)
    .map(([date, d]) => ({ date, ...d }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    period,
    total_requests: totalRequests,
    total_tokens: totalTokens,
    actual_cost: Math.round(actualCost * 10000) / 10000,
    baseline_cost: Math.round(baselineCost * 10000) / 10000,
    saved: Math.round(saved * 10000) / 10000,
    savings_pct: Math.round(savingsPct * 10) / 10,
    cache_hit_rate: totalRequests > 0 ? Math.round((cachedCount / totalRequests) * 1000) / 10 : 0,
    avg_latency_ms: totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0,
    by_model: byModel,
    daily,
  };
}

// ── GET /proxy/billing/savings ──────────────────────────────────────────────
router.get('/savings', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).auth?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const period = (req.query.period as string) || '30d';
    let since: Date;

    switch (period) {
      case '7d':   since = new Date(Date.now() - 7 * 86400000); break;
      case '30d':  since = new Date(Date.now() - 30 * 86400000); break;
      case '90d':  since = new Date(Date.now() - 90 * 86400000); break;
      case 'all':  since = new Date('2020-01-01'); break;
      default:     since = new Date(Date.now() - 30 * 86400000);
    }

    const { data, error } = await supabase
      .from('usage_logs')
      .select('id, user_id, api_key_id, provider, model, input_tokens, output_tokens, cost_usd, cached, latency_ms, routing_mode, created_at')
      .eq('user_id', userId)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Savings query error:', error);
      return res.status(500).json({ error: 'Failed to fetch usage data' });
    }

    const savings = buildSavings(data || [], period);
    return res.json(savings);
  } catch (err) {
    console.error('Savings endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /proxy/billing/savings/summary ──────────────────────────────────────
// Public aggregate — no PII. Good for landing page / Show HN.
router.get('/savings/summary', async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - 30 * 86400000);

    const { data, error } = await supabase
      .from('usage_logs')
      .select('model, input_tokens, output_tokens, cost_usd, cached, created_at')
      .gte('created_at', since.toISOString());

    if (error) {
      console.error('Summary query error:', error);
      return res.status(500).json({ error: 'Failed to fetch summary' });
    }

    const rows = (data || []) as UsageRow[];
    let totalRequests = rows.length;
    let actualCost = 0;
    let baselineCost = 0;
    let cachedCount = 0;

    for (const row of rows) {
      actualCost += row.cost_usd || 0;
      baselineCost += calcBaselineCost(row.input_tokens || 0, row.output_tokens || 0);
      if (row.cached) cachedCount++;
    }

    const saved = Math.max(0, baselineCost - actualCost);

    return res.json({
      period: '30d',
      total_requests: totalRequests,
      total_saved: Math.round(saved * 100) / 100,
      savings_pct: baselineCost > 0 ? Math.round(((saved / baselineCost) * 100) * 10) / 10 : 0,
      cache_hit_rate: totalRequests > 0 ? Math.round((cachedCount / totalRequests) * 1000) / 10 : 0,
    });
  } catch (err) {
    console.error('Summary endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
