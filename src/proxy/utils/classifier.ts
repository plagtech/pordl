/**
 * Classifies incoming requests by complexity to determine optimal routing.
 *
 * This is a heuristic classifier — fast, no ML, no external calls.
 * It analyzes the prompt content to estimate whether a cheap model
 * can handle it or if it needs a frontier model.
 *
 * Upgrade path: replace heuristics with a tiny classifier model call
 * (e.g., GPT-5 Nano at $0.05/MTok) for better accuracy.
 */

export type Complexity = "simple" | "moderate" | "complex";

export type Category = "general" | "code" | "creative";

interface ClassifyResult {
  complexity: Complexity;
  category: Category;
  reason: string;
  confidence: number;
}

// Keywords/patterns that indicate higher complexity
const COMPLEX_SIGNALS = [
  /multi[- ]?step/i,
  /step[- ]?by[- ]?step/i,
  /analyz/i,
  /compar(e|ison)/i,
  /explain.*detail/i,
  /write.*essay/i,
  /write.*article/i,
  /write.*report/i,
  /debug.*code/i,
  /refactor/i,
  /architect/i,
  /design pattern/i,
  /trade[- ]?off/i,
  /pros?\s+(and|&)\s+cons?/i,
  /research/i,
  /comprehensive/i,
  /in[- ]?depth/i,
  /thorough/i,
];

const SIMPLE_SIGNALS = [
  /^(what|who|when|where|how much|how many)\s+(is|are|was|were)\b/i,
  /translate/i,
  /summarize/i,
  /^(hi|hello|hey|thanks|thank you)/i,
  /^(yes|no|ok|okay|sure|got it)/i,
  /convert.*to/i,
  /^(list|name)\s/i,
  /format.*as/i,
  /^fix (this|the) (typo|grammar|spelling)/i,
];

const CODE_PATTERNS = [
  /```[\s\S]*```/,
  /function\s+\w+/,
  /const\s+\w+\s*=/,
  /class\s+\w+/,
  /import\s+.*from/,
  /def\s+\w+\(/,
];

// Creative-writing patterns (narrative prompts, character-driven fiction,
// chat-frontend template formats)
const CREATIVE_SIGNALS = [
  /\*[^*]+\*/, // asterisk-wrapped actions like *walks into the room*
  /{{char}}/i, // common character-template variable in chat frontends
  /{{user}}/i, // common user-template variable in chat frontends
  /<START>/i, // conversation-start marker used by some chat frontends
  /\b(roleplay|character|persona|in[- ]?character|stay in character|OOC|out of character)\b/i,
  // no trailing \b: narrat/storytell/creative writ are stems (narrative, storytelling, ...)
  /\b(narrat|storytell|creative writ|fiction|scene|dialogue)/i,
  /\b(lorebook|world[- ]?info|character[- ]?card)\b/i,
  /\b(continue the (story|scene|roleplay|narrative))\b/i,
];

export function classifyRequest(messages: Array<{ role: string; content: string }>): ClassifyResult {
  if (!messages || messages.length === 0) {
    return { complexity: "simple", category: "general", reason: "empty", confidence: 0.5 };
  }

  const lastUserMsg = [...messages]
    .reverse()
    .find((m) => m.role === "user");

  if (!lastUserMsg) {
    return { complexity: "simple", category: "general", reason: "no user message", confidence: 0.5 };
  }

  const content = lastUserMsg.content;
  const wordCount = content.split(/\s+/).length;
  const conversationLength = messages.length;

  let score = 0; // negative = simple, positive = complex

  // ── Length signals ──
  if (wordCount < 15) score -= 2;
  else if (wordCount < 50) score -= 1;
  else if (wordCount > 200) score += 2;
  else if (wordCount > 100) score += 1;

  // ── Conversation depth ──
  if (conversationLength > 10) score += 2;
  else if (conversationLength > 4) score += 1;

  // ── Pattern matching ──
  let hasAnalytical = false;
  for (const pattern of COMPLEX_SIGNALS) {
    if (pattern.test(content)) {
      score += 1.5;
      hasAnalytical = true;
      break; // one match is enough signal
    }
  }

  for (const pattern of SIMPLE_SIGNALS) {
    if (pattern.test(content)) {
      score -= 1.5;
      break;
    }
  }

  // ── Code presence ──
  const hasCode = CODE_PATTERNS.some((p) => p.test(content));
  if (hasCode) {
    // Code tasks generally need better models
    score += 1;
    // Large code blocks need even better models
    const codeBlockCount = (content.match(/```/g) || []).length / 2;
    if (codeBlockCount >= 2) score += 1;
  }

  // ── Creative-writing presence ──
  const hasCreative = CREATIVE_SIGNALS.some((p) => p.test(content));
  if (hasCreative) {
    // Creative tasks benefit from mid-tier models for prose quality
    score += 1;
  }

  // ── System prompt complexity ──
  const systemMsg = messages.find((m) => m.role === "system");
  const systemHasCreative =
    systemMsg !== undefined && CREATIVE_SIGNALS.some((p) => p.test(systemMsg.content));
  if (systemMsg && systemMsg.content.length > 500) {
    // Long system prompt with creative signals is almost certainly a
    // character card (typically 1000+ chars) — a strong creative signal.
    score += systemHasCreative ? 2 : 1;
  }

  // ── Categorize ──
  // Code wins over creative: a request that includes actual code isn't
  // "only creative" and shouldn't be capped or creative-routed.
  const isCreative = hasCreative || systemHasCreative;
  const category: Category = hasCode ? "code" : isCreative ? "creative" : "general";

  // ── Classify ──
  let complexity: Complexity;
  let confidence: number;

  if (score <= -1) {
    complexity = "simple";
    confidence = Math.min(0.95, 0.6 + Math.abs(score) * 0.1);
  } else if (score >= 2) {
    complexity = "complex";
    confidence = Math.min(0.95, 0.6 + score * 0.08);
  } else {
    complexity = "moderate";
    confidence = 0.6;
  }

  // Creative writing doesn't need frontier reasoning — it needs good prose.
  // If ONLY creative signals fired (no code, no analytical patterns),
  // cap at moderate so the router doesn't burn money on frontier models.
  if (complexity === "complex" && isCreative && !hasCode && !hasAnalytical) {
    complexity = "moderate";
  }

  return {
    complexity,
    category,
    reason: `score=${score.toFixed(1)}, words=${wordCount}, turns=${conversationLength}, code=${hasCode}, creative=${isCreative}`,
    confidence,
  };
}
