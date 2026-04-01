// @ts-check

/**
 * Autocomplete module for the Trovec query input.
 *
 * Architecture:
 *   1. ContextDetector  – inspects text up to the cursor and returns a "context kind"
 *   2. SuggestionProvider – given a context kind, returns an array of suggestion items
 *   3. DropdownUI – renders / positions the dropdown, handles keyboard & mouse selection
 *   4. Autocomplete (public) – glues the three together and attaches to a <textarea>
 */
(function () {
  // ── Suggestion catalogue ──

  const COMMANDS = [
    { label: 'db.find()',     insert: 'db.find()',     detail: 'Query entries' },
    { label: 'db.count()',    insert: 'db.count()',    detail: 'Count entries' },
    { label: 'db.stats()',    insert: 'db.stats()',    detail: 'Collection metadata' },
    { label: 'db.distinct()', insert: 'db.distinct()', detail: 'Unique field values' },
  ];

  const CHAIN_METHODS = [
    { label: '.sort()',  insert: '.sort()',  detail: 'Sort results' },
    { label: '.skip()',  insert: '.skip()',  detail: 'Skip N results' },
    { label: '.limit()', insert: '.limit()', detail: 'Limit results' },
  ];

  const OPERATORS = [
    { label: '$gt',     insert: '$gt',     detail: 'Greater than' },
    { label: '$gte',    insert: '$gte',    detail: 'Greater than or equal' },
    { label: '$lt',     insert: '$lt',     detail: 'Less than' },
    { label: '$lte',    insert: '$lte',    detail: 'Less than or equal' },
    { label: '$ne',     insert: '$ne',     detail: 'Not equal' },
    { label: '$in',     insert: '$in',     detail: 'In array' },
    { label: '$nin',    insert: '$nin',    detail: 'Not in array' },
    { label: '$regex',  insert: '$regex',  detail: 'Pattern match' },
    { label: '$exists', insert: '$exists', detail: 'Field exists' },
    { label: '$and',    insert: '$and',    detail: 'Logical AND' },
    { label: '$or',     insert: '$or',     detail: 'Logical OR' },
  ];

  const BUILT_IN_FIELDS = [
    { label: 'id', insert: 'id', detail: 'Entry ID' },
  ];

  // ── Context detection ──

  /**
   * @typedef {'command'|'chain'|'field'|'operator'|'none'} ContextKind
   * @typedef {{ kind: ContextKind, prefix: string, replaceFrom: number }} InputContext
   */

  /**
   * Analyse the text up to the cursor and decide what kind of suggestions to show.
   * @param {string} text  Full textarea value
   * @param {number} cursor  Cursor position (selectionStart)
   * @returns {InputContext}
   */
  function detectContext(text, cursor) {
    const before = text.slice(0, cursor);

    // 1. Empty or only whitespace -> command suggestions
    if (/^\s*$/.test(before)) {
      return { kind: 'command', prefix: '', replaceFrom: cursor };
    }

    // 2. Typing "db" or "db." at the start -> command
    const cmdMatch = before.match(/^\s*(db\.?\w*)$/);
    if (cmdMatch) {
      const prefix = cmdMatch[1];
      return { kind: 'command', prefix, replaceFrom: cursor - prefix.length };
    }

    // 3. After a closing paren, typing a dot -> chain method
    //    e.g. "db.find().s" or "db.find()."
    const chainMatch = before.match(/\)\s*\.(\w*)$/);
    if (chainMatch) {
      const prefix = '.' + chainMatch[1];
      return { kind: 'chain', prefix, replaceFrom: cursor - prefix.length };
    }

    // 4. Inside an object value position after "$" -> operator
    //    e.g. { "context.score": { $g
    const opMatch = before.match(/\$(\w*)$/);
    if (opMatch) {
      const prefix = '$' + opMatch[1];
      return { kind: 'operator', prefix, replaceFrom: cursor - prefix.length };
    }

    // 5. Inside an object key position -> field name
    //    Detect: after { or , followed by optional whitespace and an optional partial key
    //    We look for unquoted keys: { con  or { "con
    //    Or after comma:  , "con
    const fieldUnquotedMatch = before.match(/[{,]\s*(\w[\w.]*)$/);
    if (fieldUnquotedMatch) {
      const prefix = fieldUnquotedMatch[1];
      return { kind: 'field', prefix, replaceFrom: cursor - prefix.length };
    }

    const fieldQuotedMatch = before.match(/[{,]\s*"([\w.]*)$/);
    if (fieldQuotedMatch) {
      const prefix = fieldQuotedMatch[1];
      // replaceFrom points at the char after the opening quote
      return { kind: 'field', prefix, replaceFrom: cursor - prefix.length };
    }

    return { kind: 'none', prefix: '', replaceFrom: cursor };
  }

  // ── Suggestion provider ──

  /**
   * @typedef {{ label: string, insert: string, detail: string }} Suggestion
   */

  /**
   * @param {InputContext} ctx
   * @param {Suggestion[]} fieldSuggestions  Dynamic context.* fields from the data
   * @returns {Suggestion[]}
   */
  function getSuggestions(ctx, fieldSuggestions) {
    /** @type {Suggestion[]} */
    let pool;

    switch (ctx.kind) {
      case 'command':
        pool = COMMANDS;
        break;
      case 'chain':
        pool = CHAIN_METHODS;
        break;
      case 'operator':
        pool = OPERATORS;
        break;
      case 'field':
        pool = [...BUILT_IN_FIELDS, ...fieldSuggestions];
        break;
      default:
        return [];
    }

    if (!ctx.prefix) return pool;

    const lower = ctx.prefix.toLowerCase();
    return pool.filter(s => s.label.toLowerCase().startsWith(lower) || s.insert.toLowerCase().startsWith(lower));
  }

  // ── Dropdown UI ──

  class DropdownUI {
    constructor() {
      /** @type {HTMLDivElement} */
      this.el = document.createElement('div');
      this.el.className = 'ac-dropdown';
      document.body.appendChild(this.el);

      /** @type {Suggestion[]} */
      this.items = [];
      /** @type {number} */
      this.selectedIdx = 0;
      /** @type {((item: Suggestion) => void) | null} */
      this.onAccept = null;
    }

    /**
     * @param {Suggestion[]} items
     * @param {DOMRect} anchorRect  Bounding rect of the textarea
     * @param {number} inputScrollTop
     */
    show(items, anchorRect, inputScrollTop) {
      if (items.length === 0) { this.hide(); return; }

      this.items = items;
      this.selectedIdx = 0;
      this._render();

      // Position below the textarea
      this.el.classList.add('visible');
      this.el.style.left = anchorRect.left + 'px';
      this.el.style.top = (anchorRect.bottom + 4) + 'px';
      this.el.style.minWidth = Math.min(anchorRect.width, 350) + 'px';
    }

    hide() {
      this.el.classList.remove('visible');
      this.items = [];
    }

    get isVisible() {
      return this.el.classList.contains('visible');
    }

    moveSelection(delta) {
      if (!this.items.length) return;
      this.selectedIdx = (this.selectedIdx + delta + this.items.length) % this.items.length;
      this._render();
      this._scrollToSelected();
    }

    acceptSelected() {
      if (this.items.length && this.onAccept) {
        this.onAccept(this.items[this.selectedIdx]);
      }
      this.hide();
    }

    _render() {
      this.el.innerHTML = this.items.map((item, i) =>
        `<div class="ac-item${i === this.selectedIdx ? ' selected' : ''}" data-idx="${i}">
          <span class="ac-label">${escapeHtml(item.label)}</span>
          <span class="ac-detail">${escapeHtml(item.detail)}</span>
        </div>`
      ).join('');

      // Mouse handlers
      this.el.querySelectorAll('.ac-item').forEach(el => {
        el.addEventListener('mouseenter', () => {
          this.selectedIdx = parseInt(el.getAttribute('data-idx') || '0');
          this._render();
        });
        el.addEventListener('mousedown', (e) => {
          e.preventDefault(); // prevent textarea blur
          this.selectedIdx = parseInt(el.getAttribute('data-idx') || '0');
          this.acceptSelected();
        });
      });
    }

    _scrollToSelected() {
      const selected = this.el.querySelector('.ac-item.selected');
      if (selected) selected.scrollIntoView({ block: 'nearest' });
    }
  }

  // ── Main Autocomplete class ──

  class Autocomplete {
    /**
     * @param {HTMLTextAreaElement} textarea
     */
    constructor(textarea) {
      this.textarea = textarea;
      this.dropdown = new DropdownUI();
      /** @type {Suggestion[]} */
      this.fieldSuggestions = [];

      this.dropdown.onAccept = (item) => this._applyCompletion(item);

      this.textarea.addEventListener('input', () => this._onInput());
      this.textarea.addEventListener('keydown', (e) => this._onKeydown(e));
      this.textarea.addEventListener('blur', () => {
        // Small delay to allow mousedown on dropdown to fire first
        setTimeout(() => this.dropdown.hide(), 150);
      });
    }

    /**
     * Update the available context field paths (called when data is loaded).
     * @param {string[]} fields  e.g. ["context.pageNumber", "context.sourceFile"]
     */
    setFieldPaths(fields) {
      this.fieldSuggestions = fields.map(f => ({
        label: f,
        insert: f,
        detail: 'Context field',
      }));
    }

    _onInput() {
      const ctx = detectContext(this.textarea.value, this.textarea.selectionStart);
      const suggestions = getSuggestions(ctx, this.fieldSuggestions);

      if (suggestions.length > 0 && ctx.kind !== 'none') {
        this.dropdown.show(suggestions, this.textarea.getBoundingClientRect(), this.textarea.scrollTop);
        this._currentContext = ctx;
      } else {
        this.dropdown.hide();
        this._currentContext = null;
      }
    }

    /**
     * @param {KeyboardEvent} e
     */
    _onKeydown(e) {
      if (!this.dropdown.isVisible) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.dropdown.moveSelection(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.dropdown.moveSelection(-1);
          break;
        case 'Tab':
        case 'Enter':
          // Only accept if dropdown is visible and not Ctrl+Enter (which runs query)
          if (e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          this.dropdown.acceptSelected();
          break;
        case 'Escape':
          e.preventDefault();
          this.dropdown.hide();
          break;
      }
    }

    /**
     * @param {Suggestion} item
     */
    _applyCompletion(item) {
      const ctx = this._currentContext;
      if (!ctx) return;

      const before = this.textarea.value.slice(0, ctx.replaceFrom);
      const after = this.textarea.value.slice(this.textarea.selectionStart);

      this.textarea.value = before + item.insert + after;

      const newCursor = ctx.replaceFrom + item.insert.length;
      this.textarea.selectionStart = newCursor;
      this.textarea.selectionEnd = newCursor;
      this.textarea.focus();
    }
  }

  // ── Utility ──

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Export to window ──

  // @ts-ignore
  window.TrovecAutocomplete = Autocomplete;
})();
