import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Trovec } from '@trovec/core';
import { ingestPdf } from './ingest.js';
import { searchDocuments } from './search.js';
import { generateAnswer } from './answer.js';
import { getDocuments, addDocument, removeDocument } from './documents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

export function createServer(db: Trovec, openaiApiKey: string, port: number = 3737) {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.post('/api/ingest', upload.single('pdf'), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No PDF file uploaded' });
        return;
      }

      const result = await ingestPdf(db, req.file.path, req.file.originalname);
      addDocument({ ...result, filePath: req.file.path });
      res.json(result);
    } catch (err: any) {
      console.error('Ingest error:', err);
      res.status(500).json({ error: err.message ?? 'Ingestion failed' });
    }
  });

  app.get('/api/search', async (req, res) => {
    try {
      const query = req.query.q as string;
      const topK = parseInt(req.query.topK as string) || 5;

      if (!query) {
        res.status(400).json({ error: 'Query parameter "q" is required' });
        return;
      }

      const results = await searchDocuments(db, query, topK);
      res.json({ query, results });
    } catch (err: any) {
      console.error('Search error:', err);
      res.status(500).json({ error: err.message ?? 'Search failed' });
    }
  });

  app.post('/api/ask', async (req, res) => {
    try {
      const { question, topK } = req.body as { question?: string; topK?: number };

      if (!question) {
        res.status(400).json({ error: 'Field "question" is required' });
        return;
      }

      const sources = await searchDocuments(db, question, topK ?? 8);
      const result = await generateAnswer(openaiApiKey, question, sources);
      res.json({ question, ...result });
    } catch (err: any) {
      console.error('Ask error:', err);
      res.status(500).json({ error: err.message ?? 'Answer generation failed' });
    }
  });

  app.delete('/api/documents/:fileName', (_req, res) => {
    try {
      const fileName = _req.params.fileName;

      // Delete all vectors belonging to this document
      const keysToDelete: string[] = [];
      for (const key of db.entries.keys()) {
        if (key === fileName || key.startsWith(`${fileName}:`)) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        db.delete(key);
      }

      // Remove from document registry
      const record = removeDocument(fileName);
      if (!record && keysToDelete.length === 0) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      // Delete the uploaded file
      if (record?.filePath) {
        fs.unlink(record.filePath, () => {});
      }

      res.json({ fileName, deletedChunks: keysToDelete.length });
    } catch (err: any) {
      console.error('Delete error:', err);
      res.status(500).json({ error: err.message ?? 'Delete failed' });
    }
  });

  app.get('/api/documents', (_req, res) => {
    try {
      res.json(getDocuments());
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Failed to load documents' });
    }
  });

  app.get('/api/status', (_req, res) => {
    try {
      const s = db.stats();
      res.json({
        entryCount: s.entryCount,
        dimensions: s.dimensions,
        quantization: s.quantization,
        metric: s.metric,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Status check failed' });
    }
  });

  // /api/rebuild-status — reports documents whose registry entries exist
  // but have no vectors in the currently-active collection. This typically
  // happens after switching embedders (e.g., openai 1536d → edge 384d):
  // the previous embedder's vectors live in a separate `.trovec/<old>.trovec`
  // file that the new embedder ignores, while the shared documents.json
  // still has the registry entries.
  app.get('/api/rebuild-status', (_req, res) => {
    try {
      const docs = getDocuments();
      const indexedFileNames = new Set<string>();
      for (const key of db.entries.keys()) {
        const colon = key.indexOf(':');
        indexedFileNames.add(colon === -1 ? key : key.slice(0, colon));
      }
      const pending = docs
        .filter((d) => !indexedFileNames.has(d.fileName))
        .filter((d) => fs.existsSync(d.filePath));
      const missing = docs.filter((d) => !indexedFileNames.has(d.fileName) && !fs.existsSync(d.filePath));
      res.json({
        needsRebuild: pending.length > 0,
        pending,
        missing,
        activeEntries: db.entries.size,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Rebuild status failed' });
    }
  });

  // /api/rebuild — re-ingests pending documents through the current embedder.
  // Replaces stale registry entries (removes the old timestamp/chunk count,
  // then adds the freshly-rebuilt one). Synchronous; can take minutes for
  // large corpora on CPU inference.
  app.post('/api/rebuild', async (_req, res) => {
    try {
      const docs = getDocuments();
      const indexedFileNames = new Set<string>();
      for (const key of db.entries.keys()) {
        const colon = key.indexOf(':');
        indexedFileNames.add(colon === -1 ? key : key.slice(0, colon));
      }
      const pending = docs
        .filter((d) => !indexedFileNames.has(d.fileName))
        .filter((d) => fs.existsSync(d.filePath));

      const rebuilt: string[] = [];
      const failed: { fileName: string; error: string }[] = [];
      for (const entry of pending) {
        try {
          removeDocument(entry.fileName);
          const result = await ingestPdf(db, entry.filePath, entry.fileName);
          addDocument({ ...result, filePath: entry.filePath });
          rebuilt.push(entry.fileName);
        } catch (err: any) {
          failed.push({ fileName: entry.fileName, error: err?.message ?? String(err) });
        }
      }
      res.json({ rebuilt, failed, total: pending.length });
    } catch (err: any) {
      console.error('Rebuild error:', err);
      res.status(500).json({ error: err.message ?? 'Rebuild failed' });
    }
  });

  const server = app.listen(port, () => {
    console.log(`PDF RAG POC server running at http://localhost:${port}`);
  });

  return server;
}
