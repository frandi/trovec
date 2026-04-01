import fs from 'fs';
import path from 'path';

const DOCS_FILE = path.join('.trovec', 'documents.json');

export interface DocumentRecord {
  fileName: string;
  filePath: string;
  totalPages: number;
  totalChunks: number;
  ingestedAt: string;
}

function readAll(): DocumentRecord[] {
  try {
    const data = fs.readFileSync(DOCS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeAll(docs: DocumentRecord[]): void {
  fs.mkdirSync(path.dirname(DOCS_FILE), { recursive: true });
  fs.writeFileSync(DOCS_FILE, JSON.stringify(docs, null, 2));
}

export function getDocuments(): DocumentRecord[] {
  return readAll();
}

export function addDocument(record: Omit<DocumentRecord, 'ingestedAt'>): DocumentRecord {
  const docs = readAll();
  const entry: DocumentRecord = { ...record, ingestedAt: new Date().toISOString() };
  docs.push(entry);
  writeAll(docs);
  return entry;
}

export function removeDocument(fileName: string): DocumentRecord | null {
  const docs = readAll();
  const index = docs.findIndex((d) => d.fileName === fileName);
  if (index === -1) return null;
  const [removed] = docs.splice(index, 1);
  writeAll(docs);
  return removed;
}
