import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import type { TrovecInstance } from '@trovec/core';
import { stats } from '@trovec/core';
import { ingestPdf } from './ingest.js';
import { searchDocuments } from './search.js';
import { generateAnswer } from './answer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

export function createServer(db: TrovecInstance, openaiApiKey: string, port: number = 3737) {
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

  app.get('/api/status', (_req, res) => {
    try {
      const s = stats(db);
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

  app.listen(port, () => {
    console.log(`PDF RAG POC server running at http://localhost:${port}`);
  });

  return app;
}
