/**
 * watch.ts — /watch: read a source, diff it against the last snapshot, return
 * what changed. This is the interpretation layer that turns a read tool into a
 * monitoring product (worth pricing higher than /read).
 *
 * Mount behind x402 metering at a higher price (see README). Deps: `diff`.
 */

import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { diffLines } from 'diff';
import { read, ReadError } from './core';
import { getSnapshot, setSnapshot, type Snapshot } from './snapshot-store';

export const watchRouter = Router();

watchRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'pordl', tier: 'watch' }));

watchRouter.post('/', async (req: Request, res: Response) => {
  const { url } = (req.body ?? {}) as { url?: string };
  if (typeof url !== 'string' || !url) return res.status(400).json({ error: 'Body must include "url" (string).' });

  try {
    const current = await read(url);
    const hash = createHash('sha256').update(current.markdown).digest('hex');
    const prior = await getSnapshot(url);

    const snap: Snapshot = { url, hash, markdown: current.markdown, checkedAt: new Date().toISOString() };
    await setSnapshot(url, snap);

    const meta = { title: current.title, source: current.source, license: current.license, _pordl: { tier: 'watch' } };

    // First time we've seen this URL — nothing to compare yet.
    if (!prior) {
      return res.json({ url, changed: false, baseline: true,
        message: 'Baseline established. Call again later to detect changes.', last_checked: null, ...meta });
    }

    // Unchanged.
    if (prior.hash === hash) {
      return res.json({ url, changed: false, last_checked: prior.checkedAt, ...meta });
    }

    // Changed — compute the line-level diff.
    let added = 0, removed = 0;
    const addedChunks: string[] = [], removedChunks: string[] = [];
    for (const part of diffLines(prior.markdown, current.markdown)) {
      if (part.added) { added += part.count ?? 0; addedChunks.push(part.value); }
      else if (part.removed) { removed += part.count ?? 0; removedChunks.push(part.value); }
    }
    const cap = (s: string) => (s.length > 2000 ? s.slice(0, 2000) + '\n…(truncated)' : s);

    return res.json({
      url, changed: true, last_checked: prior.checkedAt,
      diff: {
        added_lines: added,
        removed_lines: removed,
        added: cap(addedChunks.join('\n').trim()),
        removed: cap(removedChunks.join('\n').trim()),
      },
      ...meta,
    });
  } catch (e) {
    if (e instanceof ReadError) return res.status(e.status).json({ error: e.message });
    return res.status(500).json({ error: 'Internal error.' });
  }
});
