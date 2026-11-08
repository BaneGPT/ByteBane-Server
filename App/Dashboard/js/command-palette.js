// Global command palette - Ctrl/Cmd+K
const CommandPalette = {
  isOpen: false,
  commands: [],
  filtered: [],
  selectedIndex: 0,
  recentCommands: JSON.parse(localStorage.getItem('cp_recent') || '[]'),
  
  register(commands) {
    this.commands = commands;
  },
  
  add(command) {
    this.commands.push(command);
  },
  
  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.selectedIndex = 0;
    this.filtered = this.getInitialList();
    this.render();
    this.focusInput();
  },
  
  close() {
    this.isOpen = false;
    const overlay = document.getElementById('cp-overlay');
    overlay?.remove();
  },
  
  getInitialList() {
    // Show recent commands first, then all
    const recent = this.recentCommands
      .map(id => this.commands.find(c => c.id === id))
      .filter(Boolean);
    const rest = this.commands.filter(c => !this.recentCommands.includes(c.id));
    return [...recent, ...rest];
  },
  
  filter(query) {
    if (!query) return this.getInitialList();
    const q = query.toLowerCase();
    return this.commands
      .map(cmd => {
        const label = cmd.label.toLowerCase();
        const keywords = (cmd.keywords || []).join(' ').toLowerCase();
        let score = 0;
        if (label === q) score = 100;
        else if (label.startsWith(q)) score = 80;
        else if (label.includes(q)) score = 60;
        else if (keywords.includes(q)) score = 40;
        else if (this.fuzzyMatch(label, q)) score = 20;
        return { cmd, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.cmd);
  },
  
  fuzzyMatch(str, query) {
    let si = 0, qi = 0;
    while (si < str.length && qi < query.length) {
      if (str[si] === query[qi]) qi++;
      si++;
    }
    return qi === query.length;
  },
  
  render() {
    const html = `
      <div id="cp-overlay" class="modal-overlay open" onclick="CommandPalette.close()" style="align-items:flex-start;padding-top:10vh">
        <div class="w-full max-w-xl" onclick="event.stopPropagation()" role="dialog" aria-label="Command palette" aria-modal="true">
          <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-xl);box-shadow:var(--shadow-lg);overflow:hidden">
            <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-4);border-bottom:1px solid var(--border-default)">
              <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="color:var(--text-muted)"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input id="cp-input" type="text" placeholder="Type a command or search..." 
                style="flex:1;background:transparent;border:none;color:var(--text-primary);font-size:var(--text-base);outline:none"
                oninput="CommandPalette.handleInput(this.value)"
                onkeydown="CommandPalette.handleKeydown(event)">
              <kbd style="font-size:0.625rem;padding:2px 6px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--radius-sm);color:var(--text-muted)">ESC</kbd>
            </div>
            <div id="cp-results" style="max-height:24rem;overflow-y:auto;padding:var(--space-2)"></div>
            <div style="padding:var(--space-2) var(--space-4);border-top:1px solid var(--border-default);font-size:0.625rem;color:var(--text-muted);display:flex;gap:var(--space-4)">
              <span><kbd style="font-size:0.625rem">↑↓</kbd> Navigate</span>
              <span><kbd style="font-size:0.625rem">↵</kbd> Select</span>
              <span><kbd style="font-size:0.625rem">ESC</kbd> Close</span>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
    this.renderResults();
  },
  
  renderResults() {
    const container = document.getElementById('cp-results');
    if (!container) return;
    
    if (this.filtered.length === 0) {
      container.innerHTML = `<div style="padding:var(--space-8);text-align:center;color:var(--text-muted);font-size:var(--text-sm)">No commands found</div>`;
      return;
    }
    
    // Group by category
    const groups = {};
    this.filtered.forEach((cmd, i) => {
      const cat = cmd.category || 'General';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ cmd, index: i });
    });
    
    container.innerHTML = Object.entries(groups).map(([cat, items]) => 
      `<div style="margin-bottom:var(--space-2)">
        <div style="padding:var(--space-1) var(--space-3);font-size:0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted)">${cat}</div>
        ${items.map(({ cmd, index }) => 
          `<div data-index="${index}" role="option" aria-selected="${index === this.selectedIndex}"
            onclick="CommandPalette.execute(${index})"
            onmouseenter="CommandPalette.setSelected(${index})"
            style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-2) var(--space-3);border-radius:var(--radius-md);cursor:pointer;font-size:var(--text-sm);color:var(--text-secondary);${index === this.selectedIndex ? 'background:rgba(214,120,30,0.15);color:var(--chaos-400)' : ''}"
          >
            <span style="width:1.25rem;height:1.25rem;display:flex;align-items:center;justify-content:center;opacity:0.7">${cmd.icon || '›'}</span>
            <span style="flex:1">${this.highlight(cmd.label)}</span>
            ${cmd.shortcut ? `<kbd style="font-size:0.625rem;padding:2px 6px;background:var(--bg-elevated);border:1px solid var(--border-default);border-radius:var(--radius-sm);color:var(--text-muted)">${cmd.shortcut}</kbd> ` : ''}
          </div>`
        ).join('')}
      </div>`
    ).join('');
    
    this.scrollSelectedIntoView();
  },
  
  highlight(label) {
    const input = document.getElementById('cp-input');
    const q = input?.value?.trim();
    if (!q) return label;
    const idx = label.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return label;
    return `${label.slice(0, idx)}<mark style="background:rgba(214,120,30,0.3);color:var(--chaos-300);border-radius:2px;padding:0 2px">${label.slice(idx, idx + q.length)}</mark>${label.slice(idx + q.length)}`;
  },
  
  handleInput(value) {
    this.filtered = this.filter(value);
    this.selectedIndex = 0;
    this.renderResults();
  },
  
  handleKeydown(e) {
    if (e.key === 'Escape') { this.close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIndex = Math.min(this.selectedIndex + 1, this.filtered.length - 1);
      this.renderResults();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
      this.renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.execute(this.selectedIndex);
    }
  },
  
  setSelected(index) {
    this.selectedIndex = index;
    this.renderResults();
  },
  
  scrollSelectedIntoView() {
    const el = document.querySelector(`#cp-results [data-index="${this.selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  },
  
  focusInput() {
    setTimeout(() => document.getElementById('cp-input')?.focus(), 50);
  },
  
  execute(index) {
    const cmd = this.filtered[index];
    if (!cmd) return;
    this.close();
    
    // Track recent
    this.recentCommands = [cmd.id, ...this.recentCommands.filter(id => id !== cmd.id)].slice(0, 5);
    localStorage.setItem('cp_recent', JSON.stringify(this.recentCommands));
    
    try {
      cmd.run();
    } catch (e) {
      console.error('Command failed:', e);
    }
  }
};

// Wire up global shortcut
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    CommandPalette.isOpen ? CommandPalette.close() : CommandPalette.open();
  }
});

window.CommandPalette = CommandPalette;