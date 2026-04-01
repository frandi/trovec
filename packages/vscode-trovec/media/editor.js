// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  const queryInput = /** @type {HTMLTextAreaElement} */ (document.getElementById('query-input'));
  const btnRun = document.getElementById('btn-run');
  const btnClear = document.getElementById('btn-clear');
  const resultsArea = document.getElementById('results-area');

  let currentPage = 0;
  let lastQuery = '';
  let expandedRows = new Set();

  // ── Autocomplete ──
  // @ts-ignore
  const autocomplete = new window.TrovecAutocomplete(queryInput);

  // ── Run query ──
  function runQuery(query) {
    if (!query.trim()) return;
    lastQuery = query.trim();
    currentPage = 0;
    expandedRows.clear();
    vscode.postMessage({ type: 'query', query: lastQuery });
  }

  btnRun.addEventListener('click', () => runQuery(queryInput.value));
  btnClear.addEventListener('click', () => {
    queryInput.value = '';
    resultsArea.innerHTML = '';
    queryInput.focus();
  });

  queryInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery(queryInput.value);
    }
  });

  // ── Example click handler ──
  document.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.classList.contains('example-query')) {
      queryInput.value = target.textContent || '';
      queryInput.focus();
    }
  });

  // ── Pagination ──
  function goToPage(page) {
    currentPage = page;
    expandedRows.clear();
    // Re-run query with skip
    const limit = 50;
    const skip = page * limit;
    // We add/replace .skip() and .limit() in the query
    let query = lastQuery;
    // Strip existing .skip(...) and .limit(...)
    query = query.replace(/\.skip\(\s*\d+\s*\)/g, '').replace(/\.limit\(\s*\d+\s*\)/g, '');
    query = query + `.skip(${skip}).limit(${limit})`;
    vscode.postMessage({ type: 'query', query });
  }

  // ── Receive results ──
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'result') {
      renderResult(msg.result);
    } else if (msg.type === 'fieldPaths') {
      autocomplete.setFieldPaths(msg.paths);
    }
  });

  // ── Render ──
  function renderResult(result) {
    resultsArea.innerHTML = '';

    switch (result.kind) {
      case 'error':
        renderError(result.message);
        break;
      case 'stats':
        renderStats(result);
        break;
      case 'count':
        renderCount(result);
        break;
      case 'distinct':
        renderDistinct(result);
        break;
      case 'find':
        renderFind(result);
        break;
    }
  }

  function renderError(message) {
    resultsArea.innerHTML = `<div class="result-error">${escapeHtml(message)}</div>`;
  }

  function renderStats(result) {
    resultsArea.innerHTML = `
      <dl class="result-card">
        <dt>Entries</dt>
        <dd>${result.entryCount.toLocaleString()}</dd>
        <dt>Dimensions</dt>
        <dd>${result.dimensions.toLocaleString()}</dd>
        <dt>Quantization</dt>
        <dd>${result.quantization}</dd>
        <dt>Metric</dt>
        <dd>${result.metric}</dd>
      </dl>`;
  }

  function renderCount(result) {
    resultsArea.innerHTML = `
      <dl class="result-card">
        <dt>Count</dt>
        <dd>${result.count.toLocaleString()}</dd>
      </dl>`;
  }

  function renderDistinct(result) {
    const values = result.values.map(v => `<span>${escapeHtml(String(v))}</span>`).join('');
    resultsArea.innerHTML = `
      <dl class="result-card">
        <dt>Distinct values for "${escapeHtml(result.field)}"</dt>
        <dd>${result.values.length} unique</dd>
        <dt>Values</dt>
        <dd><div class="values-list">${values}</div></dd>
      </dl>`;
  }

  function renderFind(result) {
    const { entries, total, skip, limit } = result;
    const pageCount = Math.max(1, Math.ceil(total / limit));
    const currentPageNum = Math.floor(skip / limit);

    const rangeStart = total === 0 ? 0 : skip + 1;
    const rangeEnd = skip + entries.length;
    let html = `<div class="result-summary">Showing items ${rangeStart} - ${rangeEnd} of ${total.toLocaleString()}</div>`;

    if (entries.length === 0) {
      html += `<div class="result-summary" style="opacity:0.5; margin-top:20px;">No entries match the query.</div>`;
      resultsArea.innerHTML = html;
      return;
    }

    html += `<table class="result-table">
      <thead><tr>
        <th>ID</th>
        <th>Context</th>
        <th>Embedding</th>
      </tr></thead><tbody>`;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const contextStr = entry.context ? JSON.stringify(entry.context) : '—';
      const contextPreview = truncate(contextStr, 80);
      const embeddingPreview = formatEmbeddingPreview(entry.embedding);

      html += `<tr class="clickable" data-idx="${i}">
        <td title="${escapeHtml(entry.id)}">${escapeHtml(truncate(entry.id, 40))}</td>
        <td title="${escapeHtml(contextStr)}">${escapeHtml(contextPreview)}</td>
        <td>${escapeHtml(embeddingPreview)}</td>
      </tr>`;

      // Expanded row (hidden by default)
      html += `<tr class="expanded-row" data-expanded-idx="${i}">
        <td colspan="3">
          <div class="expanded-content">
            <div class="expanded-section">
              <div class="expanded-label">ID</div>
              <div class="expanded-json">${escapeHtml(entry.id)}</div>
            </div>
            <div class="expanded-section">
              <div class="expanded-label">Context</div>
              <div class="expanded-json">${escapeHtml(entry.context ? JSON.stringify(entry.context, null, 2) : 'null')}</div>
            </div>
            <div class="expanded-section">
              <div class="expanded-label">Embedding (${entry.embedding.length} dimensions)</div>
              <div class="expanded-embedding">[${entry.embedding.map(v => v.toFixed(6)).join(', ')}]</div>
              ${renderEmbeddingStats(entry.embedding)}
            </div>
          </div>
        </td>
      </tr>`;
    }

    html += '</tbody></table>';

    // Pagination
    if (pageCount > 1) {
      html += `<div class="pagination">
        <button id="btn-prev" ${currentPageNum === 0 ? 'disabled' : ''}>Prev</button>
        <span class="page-info">Page ${currentPageNum + 1} of ${pageCount}</span>
        <button id="btn-next" ${currentPageNum >= pageCount - 1 ? 'disabled' : ''}>Next</button>
      </div>`;
    }

    resultsArea.innerHTML = html;

    // Row click to expand
    resultsArea.querySelectorAll('tr.clickable').forEach(row => {
      row.addEventListener('click', () => {
        const idx = row.getAttribute('data-idx');
        const expandedRow = resultsArea.querySelector(`tr[data-expanded-idx="${idx}"]`);
        if (!expandedRow) return;
        expandedRow.classList.toggle('visible');
      });
    });

    // Pagination buttons
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    if (btnPrev) btnPrev.addEventListener('click', () => goToPage(currentPageNum - 1));
    if (btnNext) btnNext.addEventListener('click', () => goToPage(currentPageNum + 1));
  }

  function formatEmbeddingPreview(embedding) {
    if (!embedding || embedding.length === 0) return '[]';
    const preview = embedding.slice(0, 4).map(v => v.toFixed(4)).join(', ');
    if (embedding.length > 4) return `[${preview}, ...]`;
    return `[${preview}]`;
  }

  function renderEmbeddingStats(embedding) {
    if (!embedding || embedding.length === 0) return '';
    let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;
    for (const v of embedding) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / embedding.length;
    const norm = Math.sqrt(sumSq);
    return `<div class="embedding-stats">
      <span>min: ${min.toFixed(6)}</span>
      <span>max: ${max.toFixed(6)}</span>
      <span>mean: ${mean.toFixed(6)}</span>
      <span>L2 norm: ${norm.toFixed(6)}</span>
    </div>`;
  }

  function truncate(str, len) {
    if (str.length <= len) return str;
    return str.slice(0, len - 1) + '\u2026';
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
