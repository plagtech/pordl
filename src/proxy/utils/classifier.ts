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

interface ClassifyResult {
  complexity: Complexity;
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

export function classifyRequest(messages: Array<{ role: string; content: string }>): ClassifyResult {
  if (!messages || messages.length === 0) {
    return { complexity: "simple", reason: "empty", confidence: 0.5 };
  }

  const lastUserMsg = [...messages]
    .reverse()
    .find((m) => m.role === "user");

  if (!lastUserMsg) {
    return { complexity: "simple", reason: "no user message", confidence: 0.5 };
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
  for (const pattern of COMPLEX_SIGNALS) {
    if (pattern.test(content)) {
      score += 1.5;
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

  // ── System prompt complexity ──
  const systemMsg = messages.find((m) => m.role === "system");
  if (systemMsg && systemMsg.content.length > 500) {
    score += 1; // complex system prompts usually mean complex tasks
  }

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

  return {
    complexity,
    reason: `score=${score.toFixed(1)}, words=${wordCount}, turns=${conversationLength}, code=${hasCode}`,
    confidence,
  };
}
