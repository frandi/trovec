import * as vscode from 'vscode';
import { parse, type ParsedTrovec, type TrovecEntry } from './trovecParser';
import { runQuery } from './queryEngine';
import {
  detectEncryption,
  decryptBuffer,
  resolvePassword,
  resolveRawKey,
  type ResolvedKey,
  type KeyMode,
} from './trovecDecryptor';

/** Per-file cache so we don't re-prompt on every reload. */
const keyCache = new Map<string, ResolvedKey>();

export class TrovecEditorProvider implements vscode.CustomReadonlyEditorProvider<vscode.CustomDocument> {
  public static readonly viewType = 'trovec.viewer';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      TrovecEditorProvider.viewType,
      new TrovecEditorProvider(context),
      { supportsMultipleEditorsPerDocument: false },
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };

    const fileKey = document.uri.toString();

    const loadAndRender = async (promptIfEncrypted: boolean): Promise<void> => {
      let raw: Buffer;
      try {
        raw = Buffer.from(await vscode.workspace.fs.readFile(document.uri));
      } catch (err: unknown) {
        webviewPanel.webview.html = this.getErrorHtml((err as Error).message);
        return;
      }

      const encInfo = detectEncryption(raw);

      if (encInfo) {
        // Encrypted file — resolve key (from cache or prompt)
        let resolved = keyCache.get(fileKey);

        if (!resolved && promptIfEncrypted) {
          resolved = await this.promptForKey(encInfo.mode);
          if (!resolved) {
            // User cancelled — show informational page
            webviewPanel.webview.html = this.getEncryptedHtml();
            return;
          }
        }

        if (!resolved) {
          // No cached key and not prompting (e.g. during reload) — show encrypted page
          webviewPanel.webview.html = this.getEncryptedHtml();
          return;
        }

        try {
          raw = decryptBuffer(raw, resolved);
          keyCache.set(fileKey, resolved);
        } catch (err: unknown) {
          // Wrong password / key — clear cache and show error
          keyCache.delete(fileKey);
          webviewPanel.webview.html = this.getDecryptionErrorHtml((err as Error).message);
          return;
        }
      }

      // Parse the (now plaintext) buffer
      let parsed: ParsedTrovec;
      try {
        parsed = parse(raw);
      } catch (err: unknown) {
        webviewPanel.webview.html = this.getErrorHtml((err as Error).message);
        return;
      }

      webviewPanel.webview.html = this.getHtml(webviewPanel.webview, parsed);

      const fieldPaths = extractFieldPaths(parsed.entries);
      webviewPanel.webview.postMessage({ type: 'fieldPaths', paths: fieldPaths });
    };

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'query') {
        // Re-read & parse for query execution
        let raw: Buffer;
        try {
          raw = Buffer.from(await vscode.workspace.fs.readFile(document.uri));
        } catch {
          return;
        }

        const encInfo = detectEncryption(raw);
        if (encInfo) {
          const resolved = keyCache.get(fileKey);
          if (!resolved) return;
          try {
            raw = decryptBuffer(raw, resolved);
          } catch {
            return;
          }
        }

        try {
          const parsed = parse(raw);
          const result = runQuery(msg.query, parsed.entries, parsed.header);
          webviewPanel.webview.postMessage({ type: 'result', result });
        } catch {
          // ignore query errors on stale data
        }
      } else if (msg.type === 'retry-password') {
        keyCache.delete(fileKey);
        await loadAndRender(true);
      } else if (msg.type === 'unlock') {
        await loadAndRender(true);
      }
    });

    // Initial load — prompt for password if encrypted
    await loadAndRender(true);

    // Watch for file changes
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(document.uri, '*'),
    );

    const reload = async () => {
      // Silent reload — only use cached key, don't prompt
      await loadAndRender(false);
    };

    watcher.onDidChange(reload);
    webviewPanel.onDidDispose(() => {
      watcher.dispose();
      keyCache.delete(fileKey);
    });
  }

  /**
   * Prompt the user for a decryption password or hex key.
   */
  private async promptForKey(mode: KeyMode): Promise<ResolvedKey | undefined> {
    if (mode === 'password') {
      const password = await vscode.window.showInputBox({
        prompt: 'This .trovec file is encrypted. Enter the password to decrypt it.',
        placeHolder: 'Password',
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) return undefined;
      return resolvePassword(password);
    }

    // Raw key mode
    const hexKey = await vscode.window.showInputBox({
      prompt: 'This .trovec file is encrypted with a raw key. Enter the 256-bit key as hex.',
      placeHolder: '64 hex characters (256-bit key)',
      ignoreFocusOut: true,
      validateInput(value) {
        if (!/^[0-9a-fA-F]{64}$/.test(value)) {
          return 'Key must be exactly 64 hex characters (256-bit)';
        }
        return undefined;
      },
    });
    if (!hexKey) return undefined;
    return resolveRawKey(hexKey);
  }

  private getHtml(webview: vscode.Webview, parsed: ParsedTrovec): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css'),
    );
    const acJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'autocomplete.js'),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js'),
    );

    const { header } = parsed;
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>Trovec Viewer</title>
</head>
<body>

  <div class="header">
    <span class="stat-badge">${header.dimensions} dims</span>
    <span class="stat-badge">${header.quantization}</span>
    <span class="stat-badge">${header.metric}</span>
    <span class="stat-badge">${header.entryCount.toLocaleString()} entries</span>
  </div>

  <div class="query-area">
    <textarea id="query-input" class="query-input" rows="1"
      placeholder='db.find()  |  db.find({ id: "doc-1" })  |  db.stats()'
      spellcheck="false"></textarea>
    <div class="query-actions">
      <button id="btn-run" class="btn-primary">Run</button>
      <button id="btn-clear" class="btn-secondary">Clear</button>
      <span class="query-hint">Ctrl+Enter to run</span>
    </div>
  </div>

  <div id="results-area" class="results-area">
    <div class="welcome">
      <h2>Trovec Viewer</h2>
      <p>Query your vector data using MongoDB-style syntax.</p>
      <ul class="examples">
        <li><code class="example-query">db.find()</code> — browse all entries</li>
        <li><code class="example-query">db.stats()</code> — collection metadata</li>
        <li><code class="example-query">db.count()</code> — total entry count</li>
        <li><code class="example-query">db.find({ id: "doc-1" })</code> — find by ID</li>
        <li><code class="example-query">db.find({ "context.type": "article" }).limit(10)</code> — filter by context</li>
        <li><code class="example-query">db.distinct("context.category")</code> — unique values</li>
      </ul>
    </div>
  </div>

  <script nonce="${nonce}" src="${acJsUri}"></script>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  private getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Error</title></head>
<body style="padding:20px; font-family:sans-serif; color:var(--vscode-errorForeground,#f44);">
  <h2>Failed to parse .trovec file</h2>
  <pre>${escapeHtml(message)}</pre>
</body>
</html>`;
  }

  private getEncryptedHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Encrypted</title>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}';">
</head>
<body style="padding:40px; font-family:sans-serif; text-align:center; color:var(--vscode-foreground,#ccc);">
  <h2>This file is encrypted</h2>
  <p>Enter the decryption password to view this collection.</p>
  <button id="btn-unlock" style="margin-top:12px; padding:8px 20px; cursor:pointer;">Unlock</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btn-unlock').addEventListener('click', () => {
      vscode.postMessage({ type: 'unlock' });
    });
  </script>
</body>
</html>`;
  }

  private getDecryptionErrorHtml(message: string): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Decryption Failed</title>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}';">
</head>
<body style="padding:40px; font-family:sans-serif; text-align:center; color:var(--vscode-foreground,#ccc);">
  <h2 style="color:var(--vscode-errorForeground,#f44);">Decryption failed</h2>
  <pre style="margin:12px 0;">${escapeHtml(message)}</pre>
  <button id="btn-retry" style="margin-top:12px; padding:8px 20px; cursor:pointer;">Try Again</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btn-retry').addEventListener('click', () => {
      vscode.postMessage({ type: 'retry-password' });
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Scan entries and collect all unique context field paths (e.g. "context.pageNumber").
 * Samples up to 100 entries to keep it fast on large collections.
 */
function extractFieldPaths(entries: TrovecEntry[]): string[] {
  const paths = new Set<string>();
  const sample = entries.slice(0, 100);

  for (const entry of sample) {
    if (!entry.context) continue;
    collectPaths(entry.context, 'context', paths);
  }

  return Array.from(paths).sort();
}

function collectPaths(obj: Record<string, unknown>, prefix: string, paths: Set<string>): void {
  for (const key of Object.keys(obj)) {
    const fullPath = `${prefix}.${key}`;
    paths.add(fullPath);
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      collectPaths(val as Record<string, unknown>, fullPath, paths);
    }
  }
}
