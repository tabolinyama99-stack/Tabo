/* College Management System – single page front-end (no build step). */
(() => {
  'use strict';

  const state = { settings: {}, me: null, meta: null, list: {}, optionCache: {} };
  const root = document.getElementById('root');
  const ROLE_NAMES = { super_admin: 'Super Admin', admin: 'Admin', teacher: 'Teacher', student: 'Student' };
  const NAV_GROUPS = [
    ['Academics', ['students', 'teachers', 'departments', 'courses', 'enrollments', 'timetable']],
    ['Records', ['attendance', 'grades', 'fees']],
    ['Communication', ['notices']],
    ['Administration', ['users']]
  ];

  // ------------------------------------------------------------ helpers
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const isSuper = () => state.me && state.me.role === 'super_admin';
  const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
  const safeUrl = u => (/^(\/|https?:\/\/|data:image\/)/i.test(String(u || '')) ? String(u) : '');

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && url !== '/api/login' && url !== '/api/me') { state.me = null; renderLogin(); }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function toast(msg, type = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), type === 'error' ? 6000 : 3000);
  }

  function modal({ title, body, footer = '', wide = false, onClose }) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></header>
      <div class="body"></div>${footer ? `<footer>${footer}</footer>` : ''}</div>`;
    const bodyEl = $('.body', bg);
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
    $$('[data-close]', bg).forEach(b => b.addEventListener('click', close));
    document.body.appendChild(bg);
    return { el: bg, body: bodyEl, close };
  }

  function confirmDialog(message, { title = 'Are you sure?', okText = 'Delete', danger = true, typeToConfirm = '' } = {}) {
    return new Promise(resolve => {
      let done = false;
      const m = modal({
        title,
        body: `<p>${esc(message)}</p>${typeToConfirm ? `<div class="field"><label>Type <b>${esc(typeToConfirm)}</b> to confirm</label><input id="cf-type" autocomplete="off"></div>` : ''}`,
        footer: `<button data-close>Cancel</button><button id="cf-ok" class="${danger ? 'btn-danger' : 'btn-primary'}">${esc(okText)}</button>`,
        onClose: () => { if (!done) resolve(false); }
      });
      const ok = $('#cf-ok', m.el);
      if (typeToConfirm) {
        ok.disabled = true;
        $('#cf-type', m.el).addEventListener('input', e => { ok.disabled = e.target.value !== typeToConfirm; });
        $('#cf-type', m.el).focus();
      } else ok.focus();
      ok.addEventListener('click', () => { done = true; m.close(); resolve(true); });
    });
  }

  function readFile(file, as = 'dataUrl') {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read file'));
      if (as === 'text') r.readAsText(file); else r.readAsDataURL(file);
    });
  }

  async function uploadImage(file) {
    if (!file) return null;
    if (file.size > 8 * 1024 * 1024) throw new Error('Image is too large (max 8 MB)');
    const dataUrl = await readFile(file);
    return (await api('POST', '/api/upload', { dataUrl })).url;
  }

  function money(n) {
    const cur = state.settings.currency || '';
    const v = Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    return cur ? `${cur} ${v}` : v;
  }

  const GOOD = ['Active', 'Present', 'Paid', 'Enrolled', 'Completed', 'Graduated'];
  const BAD = ['Absent', 'Unpaid', 'Suspended', 'Discontinued', 'Dropped', 'Resigned'];
  const WARN = ['Partial', 'Late', 'On Leave', 'Deferred', 'Excused', 'Retired'];

  function cell(entity, f, row, labels) {
    const v = row[f.name];
    if (f.type === 'image') {
      const url = safeUrl(v);
      const name = row.name || [row.first_name, row.last_name].filter(Boolean).join(' ');
      return url ? `<img class="thumb" src="${esc(url)}" alt="">` : `<span class="avatar sm">${esc(initials(name))}</span>`;
    }
    if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
    if (f.type === 'ref') return esc((labels && labels[f.name] && labels[f.name][v]) || `#${v}`);
    if (f.type === 'boolean') return Number(v) ? '✔️' : '<span class="muted">—</span>';
    if (f.type === 'color') return `<span class="swatch" style="background:${esc(v)}"></span> ${esc(v)}`;
    if (f.name === 'role') return `<span class="pill">${esc(ROLE_NAMES[v] || v)}</span>`;
    if (f.type === 'select') {
      const cls = GOOD.includes(v) ? 'good' : BAD.includes(v) ? 'bad' : WARN.includes(v) ? 'warn' : '';
      return `<span class="pill ${cls}">${esc(v)}</span>`;
    }
    if (entity === 'fees' && (f.name === 'amount' || f.name === 'paid')) return esc(money(v));
    return esc(v);
  }

  function plainValue(f, row, labels) {
    const v = row[f.name];
    if (v === null || v === undefined) return '';
    if (f.type === 'ref') return (labels && labels[f.name] && labels[f.name][v]) || v;
    if (f.type === 'boolean') return Number(v) ? 'Yes' : 'No';
    return v;
  }

  // ------------------------------------------------------------ branding

  function applyBranding() {
    const s = state.settings;
    const r = document.documentElement.style;
    if (s.primary_color) r.setProperty('--primary', s.primary_color);
    if (s.sidebar_color) r.setProperty('--sidebar', s.sidebar_color);
    document.title = s.college_name || 'College Management System';
    const fav = safeUrl(s.favicon) || safeUrl(s.logo);
    if (fav) $('#favicon').href = fav;
  }

  async function loadSettings() {
    state.settings = await api('GET', '/api/settings');
    applyBranding();
  }

  // ------------------------------------------------------------ login

  function renderLogin() {
    const s = state.settings;
    const bg = safeUrl(s.login_background);
    root.innerHTML = `
      <div class="login-wrap" ${bg ? `style="background-image:linear-gradient(rgba(10,16,40,.55),rgba(10,16,40,.55)),url('${esc(bg)}')"` : ''}>
        <div>
          <form class="login-card" id="login-form">
            <div class="brand">
              <img src="${esc(safeUrl(s.logo) || '/default-logo.svg')}" alt="Logo">
              <h1>${esc(s.college_name)}</h1>
              <div class="muted">${esc(s.tagline)}</div>
            </div>
            <p class="muted" style="text-align:center">${esc(s.login_message)}</p>
            <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>
            <div class="field"><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required></div>
            <button class="btn-primary" style="width:100%;justify-content:center;padding:10px">Sign in</button>
          </form>
          <div class="login-footer">${esc(s.footer_text)}</div>
        </div>
      </div>`;
    $('#login-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('button', e.target);
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/login', { email: $('#email').value, password: $('#password').value });
        state.me = r.user;
        await startApp();
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
    $('#email').focus();
  }

  // ------------------------------------------------------------ shell

  async function startApp() {
    state.meta = await api('GET', '/api/meta');
    state.optionCache = {};
    renderShell();
    route();
  }

  function navLink(href, icon, label, tag = '') {
    return `<a href="${href}" data-href="${href}"><span class="ic">${esc(icon)}</span><span>${esc(label)}</span>${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</a>`;
  }

  function renderShell() {
    const s = state.settings;
    const me = state.me;
    const ents = state.meta.entities;
    let nav = navLink('#/dashboard', '🏠', 'Dashboard');
    const used = new Set();
    for (const [group, keys] of NAV_GROUPS) {
      const links = keys.filter(k => ents[k] && (!ents[k].hidden || isSuper())).map(k => {
        used.add(k);
        return navLink(`#/m/${k}`, ents[k].icon, ents[k].label, ents[k].hidden ? 'hidden' : '');
      });
      if (links.length) nav += `<div class="nav-group">${group}</div>` + links.join('');
    }
    if (isSuper()) {
      nav += `<div class="nav-group">Super Admin</div>` +
        navLink('#/settings/branding', '🎨', 'Branding & Logo') +
        navLink('#/settings/modules', '🧩', 'Modules & Permissions') +
        navLink('#/settings/fields', '➕', 'Custom Fields') +
        navLink('#/settings/general', '⚙️', 'General Settings') +
        navLink('#/settings/data', '🗄️', 'Backup & Danger Zone') +
        navLink('#/audit', '🕵️', 'Audit Log');
    }
    const avatar = safeUrl(me.avatar)
      ? `<img class="avatar" src="${esc(safeUrl(me.avatar))}" alt="">`
      : `<span class="avatar">${esc(initials(me.name))}</span>`;
    root.innerHTML = `
      <div class="app" id="app">
        <aside class="sidebar">
          <a class="brand" href="#/dashboard">
            <img src="${esc(safeUrl(s.logo) || '/default-logo.svg')}" alt="Logo">
            <span><strong>${esc(s.college_name)}</strong><small>${esc(s.tagline)}</small></span>
          </a>
          <nav class="nav">${nav}</nav>
          <div class="spacer"></div>
          <div class="nav" style="margin-top:14px">${navLink('#/profile', '👤', 'My Profile')}<a href="#" id="logout"><span class="ic">🚪</span><span>Sign out</span></a></div>
        </aside>
        <div class="main">
          <header class="topbar">
            <button class="icon-btn menu-btn" id="menu-btn" aria-label="Menu">☰</button>
            <div class="title" id="page-title"></div>
            <a class="user-chip" href="#/profile">${avatar}<span class="who"><div style="font-weight:600">${esc(me.name)}</div><span class="role-badge">${esc(ROLE_NAMES[me.role] || me.role)}</span></span></a>
          </header>
          <main class="content" id="view"></main>
          <footer class="footer">${esc(s.footer_text)}${s.academic_year ? ` · Academic year ${esc(s.academic_year)}` : ''}</footer>
        </div>
      </div>`;
    $('#logout').addEventListener('click', async e => {
      e.preventDefault();
      await api('POST', '/api/logout').catch(() => {});
      state.me = null;
      location.hash = '';
      renderLogin();
    });
    $('#menu-btn').addEventListener('click', () => $('#app').classList.toggle('nav-open'));
  }

  function setTitle(t) {
    const el = $('#page-title');
    if (el) el.textContent = t;
  }

  function route() {
    if (!state.me) return renderLogin();
    if (!$('#view')) renderShell();
    const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
    const [page, arg] = hash.split('/');
    $$('.nav a[data-href]').forEach(a => a.classList.toggle('active', location.hash === a.dataset.href || (hash === 'dashboard' && a.dataset.href === '#/dashboard')));
    $('#app') && $('#app').classList.remove('nav-open');
    const view = $('#view');
    view.innerHTML = '<div class="muted">Loading…</div>';
    window.scrollTo(0, 0);
    try {
      if (page === 'dashboard') return renderDashboard(view);
      if (page === 'm' && state.meta.entities[arg]) return renderList(view, arg);
      if (page === 'profile') return renderProfile(view);
      if (page === 'settings' && isSuper()) return renderSettings(view, arg || 'branding');
      if (page === 'audit' && isSuper()) return renderAudit(view);
      view.innerHTML = '<div class="card empty">Page not found or you do not have access.</div>';
    } catch (e) { view.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------ dashboard

  async function renderDashboard(view) {
    setTitle('Dashboard');
    const d = await api('GET', '/api/dashboard');
    const ents = state.meta.entities;
    const me = state.me;
    const statCards = Object.entries(d.counts).filter(([k]) => ents[k]).map(([k, n]) => `
      <a class="card stat" href="#/m/${k}"><span class="ic">${esc(ents[k].icon)}</span>
      <span><div class="num">${n.toLocaleString()}</div><div class="lbl">${esc(ents[k].label)}</div></span></a>`).join('');

    let blocks = '';
    if (d.fees) {
      const pct = d.fees.due ? Math.min(100, Math.round((d.fees.paid / d.fees.due) * 100)) : 0;
      blocks += `<div class="card"><h2>💰 ${me.role === 'student' ? 'My Fees' : 'Fee Collection'}</h2>
        <div class="progress"><span style="width:${pct}%"></span></div>
        <div>${pct}% collected</div>
        <div class="muted">Paid ${esc(money(d.fees.paid))} of ${esc(money(d.fees.due))} · Balance <b>${esc(money(d.fees.due - d.fees.paid))}</b></div></div>`;
    }
    if (d.attendance && d.attendance.length) {
      const total = d.attendance.reduce((a, r) => a + r.n, 0);
      blocks += `<div class="card"><h2>✅ ${me.role === 'student' ? 'My Attendance' : 'Attendance'}</h2>` +
        d.attendance.map(r => `<div class="bar-row"><span class="name">${esc(r.status)}</span><span class="bar"><span style="width:${(r.n / total) * 100}%"></span></span><span>${Math.round((r.n / total) * 100)}%</span></div>`).join('') + '</div>';
    }
    if (d.studentsByDept && d.studentsByDept.length) {
      const max = Math.max(...d.studentsByDept.map(r => r.n));
      blocks += `<div class="card"><h2>🏛️ Students by Department</h2>` +
        d.studentsByDept.map(r => `<div class="bar-row"><span class="name" title="${esc(r.name)}">${esc(r.name)}</span><span class="bar"><span style="width:${(r.n / max) * 100}%"></span></span><span>${r.n}</span></div>`).join('') + '</div>';
    }
    if (d.myCourses) {
      blocks += `<div class="card"><h2>📚 My Courses</h2>${d.myCourses.length ? d.myCourses.map(c => `<div class="activity"><b>${esc(c.code)}</b> ${esc(c.title)}</div>`).join('') : '<div class="muted">Not enrolled in any course yet.</div>'}</div>`;
    }
    if (d.grades) {
      blocks += `<div class="card"><h2>🏅 Recent Grades</h2>${d.grades.length ? `<table><tbody>${d.grades.map(g => `<tr><td>${esc(g.code)}</td><td>${esc(g.assessment)}</td><td>${esc(g.score)}/${esc(g.max_score)}</td><td><b>${esc(g.grade)}</b></td></tr>`).join('')}</tbody></table>` : '<div class="muted">No grades yet.</div>'}</div>`;
    }
    if (d.notices) {
      blocks += `<div class="card"><h2>📢 Notices</h2>${d.notices.length ? d.notices.map(n => `<div class="notice"><div class="t">${n.pinned ? '📌 ' : ''}${esc(n.title)}</div><div class="muted" style="font-size:12px">${esc(n.publish_date || '')} · ${esc(n.audience || 'Everyone')}</div><div class="b">${esc(n.body)}</div></div>`).join('') : '<div class="muted">No notices.</div>'}</div>`;
    }
    if (d.recent) {
      blocks += `<div class="card"><h2>🕵️ Recent Activity</h2>${d.recent.map(a => `<div class="activity"><b>${esc(a.user_name)}</b> ${esc(a.action)} <span class="muted">${esc(a.entity || '')}${a.record_id ? ' #' + a.record_id : ''}</span> ${esc(a.details && a.details.length < 80 ? a.details : '')}<div class="muted" style="font-size:11px">${esc(a.created_at)} UTC</div></div>`).join('')}<a href="#/audit">View all →</a></div>`;
    }
    let welcome = '';
    if (me.role === 'student' && !me.student_id) welcome = '<div class="card" style="margin-bottom:16px">Your login is not linked to a student record yet. Ask the administrator to link it.</div>';
    view.innerHTML = `
      <h1>Welcome, ${esc(me.name.split(' ')[0])} 👋</h1>
      <p class="muted">${esc(state.settings.college_name)} · ${esc(ROLE_NAMES[me.role])}${isSuper() ? ' — you have full control over every record, logo and setting.' : ''}</p>
      ${welcome}
      <div class="grid stats" style="margin-bottom:16px">${statCards}</div>
      <div class="grid two">${blocks}</div>`;
  }

  // ------------------------------------------------------------ generic list

  function listState(key) {
    if (!state.list[key]) state.list[key] = { q: '', sort: '', dir: 'desc', page: 1, limit: 25, selected: new Set() };
    return state.list[key];
  }

  function queryString(ls, extra = {}) {
    const p = new URLSearchParams({ q: ls.q, sort: ls.sort, dir: ls.dir, page: ls.page, limit: ls.limit, ...extra });
    return p.toString();
  }

  async function renderList(view, key) {
    const meta = state.meta.entities[key];
    const ls = listState(key);
    setTitle(meta.label);
    const cols = meta.fields.filter(f => f.list);
    view.innerHTML = `
      <div class="toolbar">
        <input class="search" type="search" placeholder="Search ${esc(meta.label.toLowerCase())}…" value="${esc(ls.q)}">
        <span class="grow"></span>
        <button id="bulk-del" class="btn-danger hidden">🗑 Delete selected</button>
        <button id="export">⬇ Export CSV</button>
        ${meta.canWrite ? '<button id="import">⬆ Import CSV</button>' : ''}
        <button id="print">🖨 Print</button>
        ${meta.canWrite ? `<button id="add" class="btn-primary">＋ Add ${esc(meta.singular)}</button>` : ''}
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          ${meta.canDelete ? '<th style="width:30px"><input type="checkbox" id="sel-all" aria-label="Select all"></th>' : ''}
          ${cols.map(f => `<th class="${f.custom ? '' : 'sortable'}" data-sort="${f.custom ? '' : esc(f.name)}">${esc(f.label)}${ls.sort === f.name ? (ls.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('')}
          <th class="actions"></th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="99" class="empty">Loading…</td></tr></tbody>
      </table></div>
      <div class="pager"><span class="muted" id="count"></span><span id="pages"></span></div>`;

    let timer;
    $('.search', view).addEventListener('input', e => {
      clearTimeout(timer);
      timer = setTimeout(() => { ls.q = e.target.value; ls.page = 1; load(); }, 250);
    });
    $$('th.sortable', view).forEach(th => th.addEventListener('click', () => {
      const s = th.dataset.sort;
      if (ls.sort === s) ls.dir = ls.dir === 'asc' ? 'desc' : 'asc'; else { ls.sort = s; ls.dir = 'asc'; }
      renderList(view, key);
    }));
    $('#add', view) && $('#add', view).addEventListener('click', () => openForm(key, null, load));
    $('#print', view).addEventListener('click', () => window.print());
    $('#export', view).addEventListener('click', () => exportCsv(key));
    $('#import', view) && $('#import', view).addEventListener('click', () => importCsv(key, load));
    $('#bulk-del', view).addEventListener('click', async () => {
      const ids = [...ls.selected];
      if (!await confirmDialog(`Permanently delete ${ids.length} ${meta.label.toLowerCase()}? Related records (e.g. grades, fees, attendance) will also be deleted.`)) return;
      try {
        const r = await api('POST', `/api/data/${key}/bulk-delete`, { ids });
        toast(`Deleted ${r.deleted}${r.cascaded ? ` (+${r.cascaded} related)` : ''}`, 'ok');
        r.errors.forEach(e => toast(e, 'error'));
        ls.selected.clear();
        load();
      } catch (e) { toast(e.message, 'error'); }
    });

    async function load() {
      let data;
      try { data = await api('GET', `/api/data/${key}?${queryString(ls)}`); } catch (e) { $('#rows', view).innerHTML = `<tr><td colspan="99" class="empty">${esc(e.message)}</td></tr>`; return; }
      const tbody = $('#rows', view);
      if (!tbody) return;
      ls.selected.clear();
      updateBulk();
      if (!data.rows.length) {
        tbody.innerHTML = `<tr><td colspan="99" class="empty">${ls.q ? 'No matches.' : `No ${esc(meta.label.toLowerCase())} yet.`}${meta.canWrite && !ls.q ? ' Click “Add” to create one.' : ''}</td></tr>`;
      } else {
        tbody.innerHTML = data.rows.map(row => `<tr data-id="${row.id}">
          ${meta.canDelete ? `<td><input type="checkbox" class="sel" value="${row.id}" aria-label="Select"></td>` : ''}
          ${cols.map(f => `<td class="cell">${cell(key, f, row, data.labels)}</td>`).join('')}
          <td class="actions">
            <button class="icon-btn" data-act="view" title="View">👁</button>
            ${meta.canWrite ? '<button class="icon-btn" data-act="edit" title="Edit">✏️</button>' : ''}
            ${meta.canDelete ? '<button class="icon-btn" data-act="del" title="Delete">🗑</button>' : ''}
          </td></tr>`).join('');
      }
      const pages = Math.max(1, Math.ceil(data.total / data.limit));
      $('#count', view).textContent = `${data.total.toLocaleString()} record${data.total === 1 ? '' : 's'}`;
      $('#pages', view).innerHTML = pages > 1 ? `<button class="btn-sm" id="prev" ${ls.page <= 1 ? 'disabled' : ''}>‹ Prev</button> Page ${ls.page} of ${pages} <button class="btn-sm" id="next" ${ls.page >= pages ? 'disabled' : ''}>Next ›</button>` : '';
      $('#prev', view) && $('#prev', view).addEventListener('click', () => { ls.page--; load(); });
      $('#next', view) && $('#next', view).addEventListener('click', () => { ls.page++; load(); });

      $$('tbody tr[data-id]', view).forEach(tr => {
        const row = data.rows.find(r => String(r.id) === tr.dataset.id);
        $$('[data-act]', tr).forEach(b => b.addEventListener('click', async () => {
          const act = b.dataset.act;
          if (act === 'view') showRecord(key, row, data.labels, load);
          if (act === 'edit') openForm(key, row, load);
          if (act === 'del') deleteOne(key, row, load);
        }));
        const sel = $('.sel', tr);
        sel && sel.addEventListener('change', () => { sel.checked ? ls.selected.add(row.id) : ls.selected.delete(row.id); updateBulk(); });
      });
      const all = $('#sel-all', view);
      if (all) {
        all.checked = false;
        all.onchange = () => { $$('.sel', view).forEach(c => { c.checked = all.checked; all.checked ? ls.selected.add(Number(c.value)) : ls.selected.delete(Number(c.value)); }); updateBulk(); };
      }
    }
    function updateBulk() {
      const b = $('#bulk-del', view);
      if (!b) return;
      b.classList.toggle('hidden', ls.selected.size === 0);
      b.textContent = `🗑 Delete selected (${ls.selected.size})`;
    }
    load();
  }

  async function deleteOne(key, row, after) {
    const meta = state.meta.entities[key];
    if (!await confirmDialog(`Permanently delete this ${meta.singular.toLowerCase()} (#${row.id})? Records that belong to it will also be deleted. This cannot be undone.`)) return;
    try {
      const r = await api('DELETE', `/api/data/${key}/${row.id}`);
      toast(`${meta.singular} deleted${r.cascaded ? ` (+${r.cascaded} related records)` : ''}`, 'ok');
      after && after();
    } catch (e) { toast(e.message, 'error'); }
  }

  function showRecord(key, row, labels, after) {
    const meta = state.meta.entities[key];
    const img = meta.fields.find(f => f.type === 'image' && row[f.name]);
    const body = `${img ? `<div style="margin-bottom:14px"><img src="${esc(safeUrl(row[img.name]))}" style="max-height:140px;border-radius:12px" alt=""></div>` : ''}
      <dl class="details">${meta.fields.filter(f => f.type !== 'image' && f.type !== 'password').map(f => `<dt>${esc(f.label)}</dt><dd>${cell(key, f, row, labels)}</dd>`).join('')}
      <dt>Record ID</dt><dd>#${row.id}</dd><dt>Created</dt><dd>${esc(row.created_at)} UTC</dd><dt>Last updated</dt><dd>${esc(row.updated_at)} UTC</dd></dl>`;
    const m = modal({
      title: `${meta.singular} #${row.id}`, body, wide: true,
      footer: `${meta.canDelete ? '<button class="btn-danger" id="v-del">Delete</button>' : ''}<span style="flex:1"></span><button data-close>Close</button>${meta.canWrite ? '<button class="btn-primary" id="v-edit">Edit</button>' : ''}`
    });
    $('#v-edit', m.el) && $('#v-edit', m.el).addEventListener('click', () => { m.close(); openForm(key, row, after); });
    $('#v-del', m.el) && $('#v-del', m.el).addEventListener('click', () => { m.close(); deleteOne(key, row, after); });
  }

  async function refOptions(entity) {
    if (!state.optionCache[entity]) state.optionCache[entity] = api('GET', `/api/options/${entity}`).catch(() => null);
    return state.optionCache[entity];
  }

  function inputFor(f, value) {
    const id = `f-${f.name}`;
    const v = value ?? (f.default ?? '');
    const req = f.required ? 'required' : '';
    const dis = f.readonly ? 'disabled' : '';
    switch (f.type) {
      case 'textarea': return `<textarea id="${id}" name="${esc(f.name)}" ${req} ${dis}>${esc(v)}</textarea>`;
      case 'select': {
        const opts = (f.options || []).slice();
        if (v && !opts.includes(String(v))) opts.push(String(v));
        const labelOf = o => f.name === 'role' ? (ROLE_NAMES[o] || o) : o;
        return `<select id="${id}" name="${esc(f.name)}" ${req} ${dis}><option value="">— Select —</option>${opts.map(o => `<option value="${esc(o)}" ${String(v) === String(o) ? 'selected' : ''}>${esc(labelOf(o))}</option>`).join('')}</select>`;
      }
      case 'ref': return `<select id="${id}" name="${esc(f.name)}" data-ref="${esc(f.ref)}" data-value="${esc(v)}" ${req} ${dis}><option value="">Loading…</option></select>`;
      case 'boolean': return `<label class="check"><input type="checkbox" id="${id}" name="${esc(f.name)}" ${Number(v) ? 'checked' : ''} ${dis}> Yes</label>`;
      case 'image': return `<div class="img-field"><img src="${esc(safeUrl(v) || '/default-logo.svg')}" alt="" data-preview style="${v ? '' : 'opacity:.3'}">
          <input type="hidden" name="${esc(f.name)}" value="${esc(v)}">
          <div><input type="file" accept="image/*" data-upload="${esc(f.name)}" ${dis}><button type="button" class="btn-sm btn-ghost" data-clear="${esc(f.name)}">Remove</button></div></div>`;
      case 'password': return `<input id="${id}" type="password" name="${esc(f.name)}" autocomplete="new-password" minlength="6">`;
      case 'number': return `<input id="${id}" type="number" step="any" name="${esc(f.name)}" value="${esc(v)}" ${req} ${dis}>`;
      case 'date': case 'time': case 'email': case 'color':
        return `<input id="${id}" type="${f.type}" name="${esc(f.name)}" value="${esc(v || (f.type === 'color' ? '#000000' : ''))}" ${req} ${dis}>`;
      default: return `<input id="${id}" type="text" name="${esc(f.name)}" value="${esc(v)}" ${req} ${dis}>`;
    }
  }

  function bindImageInputs(scope) {
    $$('[data-upload]', scope).forEach(inp => inp.addEventListener('change', async () => {
      const wrap = inp.closest('.img-field');
      try {
        const url = await uploadImage(inp.files[0]);
        $(`input[type=hidden]`, wrap).value = url;
        const p = $('[data-preview]', wrap); p.src = url; p.style.opacity = 1;
        wrap.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) { toast(e.message, 'error'); inp.value = ''; }
    }));
    $$('[data-clear]', scope).forEach(b => b.addEventListener('click', () => {
      const wrap = b.closest('.img-field');
      $(`input[type=hidden]`, wrap).value = '';
      const p = $('[data-preview]', wrap); p.src = '/default-logo.svg'; p.style.opacity = .3;
      $('[data-upload]', wrap).value = '';
      wrap.dispatchEvent(new Event('change', { bubbles: true }));
    }));
  }

  function openForm(key, row, after) {
    const meta = state.meta.entities[key];
    const editing = !!row;
    const fields = meta.fields.filter(f => !(f.readonly && !editing));
    const form = document.createElement('form');
    form.className = 'form-grid';
    form.innerHTML = fields.map(f => `<div class="field ${['textarea', 'image'].includes(f.type) ? 'full' : ''}">
        <label for="f-${esc(f.name)}">${esc(f.label)}${f.required && !(f.type === 'password') ? ' <span class="req">*</span>' : ''}${f.custom ? ' <span class="muted">(custom)</span>' : ''}</label>
        ${inputFor(f, row ? row[f.name] : undefined)}</div>`).join('') + '<button type="submit" hidden></button>';
    const m = modal({
      title: `${editing ? 'Edit' : 'New'} ${meta.singular}${editing ? ' #' + row.id : ''}`, body: form, wide: true,
      footer: `<button data-close>Cancel</button><button class="btn-primary" id="save">${editing ? 'Save changes' : 'Create'}</button>`
    });
    bindImageInputs(form);
    $$('select[data-ref]', form).forEach(async sel => {
      const opts = await refOptions(sel.dataset.ref);
      const cur = sel.dataset.value;
      if (!opts) {
        sel.outerHTML = `<input type="number" name="${esc(sel.name)}" value="${esc(cur)}" placeholder="Record ID">`;
        return;
      }
      sel.innerHTML = `<option value="">— None —</option>` + opts.map(o => `<option value="${o.id}" ${String(o.id) === String(cur) ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
    });
    const submit = async () => {
      if (!form.reportValidity()) return;
      const body = {};
      for (const f of fields) {
        if (f.readonly) continue;
        const el = form.elements[f.name];
        if (!el) continue;
        body[f.name] = f.type === 'boolean' ? (el.checked ? 1 : 0) : el.value;
        if (f.type === 'password' && !el.value) delete body[f.name];
      }
      const btn = $('#save', m.el);
      btn.disabled = true;
      try {
        if (editing) await api('PUT', `/api/data/${key}/${row.id}`, body);
        else await api('POST', `/api/data/${key}`, body);
        delete state.optionCache[key];
        toast(`${meta.singular} ${editing ? 'updated' : 'created'}`, 'ok');
        m.close();
        after && after();
        if (key === 'users' && editing && row.id === state.me.id) { state.me = (await api('GET', '/api/me')).user; renderShell(); route(); }
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    };
    form.addEventListener('submit', e => { e.preventDefault(); submit(); });
    $('#save', m.el).addEventListener('click', submit);
    const first = $('input:not([type=hidden]):not([type=file]), select, textarea', form);
    first && first.focus();
  }

  // ------------------------------------------------------------ CSV

  function toCsv(rows) {
    return rows.map(r => r.map(v => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
  }

  function parseCsv(text) {
    const rows = [];
    let row = [], val = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { val += '"'; i++; } else if (c === '"') q = false; else val += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(val); val = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(val); rows.push(row); row = []; val = '';
      } else val += c;
    }
    if (val !== '' || row.length) { row.push(val); rows.push(row); }
    return rows.filter(r => r.some(v => v.trim() !== ''));
  }

  function download(name, content, type = 'text/csv') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function exportCsv(key) {
    const meta = state.meta.entities[key];
    const ls = listState(key);
    try {
      const data = await api('GET', `/api/data/${key}?${queryString(ls, { all: 1 })}`);
      const fields = meta.fields.filter(f => f.type !== 'password' && f.type !== 'image');
      const out = [['id', ...fields.map(f => f.label)], ...data.rows.map(r => [r.id, ...fields.map(f => plainValue(f, r, data.labels))])];
      download(`${key}-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + toCsv(out));
    } catch (e) { toast(e.message, 'error'); }
  }

  function importCsv(key, after) {
    const meta = state.meta.entities[key];
    const fields = meta.fields.filter(f => !f.readonly && f.type !== 'image');
    const template = toCsv([fields.map(f => f.name)]);
    const m = modal({
      title: `Import ${meta.label} from CSV`,
      body: `<p>Upload a CSV file whose first row contains column names. Columns can use either the field name or its label:</p>
        <p class="muted" style="font-size:12px">${fields.map(f => `<code>${esc(f.name)}</code>${f.required ? '*' : ''}`).join(', ')}</p>
        <p class="muted" style="font-size:12px">For linked records (e.g. Student, Course, Department) put the record ID or its exact code/reg. no.</p>
        <p><a href="#" id="tpl">Download a blank template</a></p>
        <input type="file" accept=".csv,text/csv" id="csv-file"><div id="imp-result" style="margin-top:12px"></div>`,
      footer: '<button data-close>Close</button><button class="btn-primary" id="do-import">Import</button>'
    });
    $('#tpl', m.el).addEventListener('click', e => { e.preventDefault(); download(`${key}-template.csv`, template); });
    $('#do-import', m.el).addEventListener('click', async () => {
      const file = $('#csv-file', m.el).files[0];
      if (!file) return toast('Choose a CSV file first', 'error');
      const btn = $('#do-import', m.el);
      btn.disabled = true;
      try {
        const rows = parseCsv(await readFile(file, 'text'));
        if (rows.length < 2) throw new Error('The file has no data rows');
        const header = rows[0].map(h => h.trim().toLowerCase());
        const map = header.map(h => fields.find(f => f.name.toLowerCase() === h || f.label.toLowerCase() === h));
        // Resolve linked records by label/code.
        const refMaps = {};
        for (const f of fields.filter(f => f.type === 'ref')) {
          const opts = (await refOptions(f.ref)) || [];
          refMaps[f.name] = new Map();
          for (const o of opts) {
            refMaps[f.name].set(o.label.toLowerCase(), o.id);
            refMaps[f.name].set(o.label.split(/\s+[–-]\s+|\s+/)[0].toLowerCase(), o.id);
          }
        }
        const records = rows.slice(1).map(r => {
          const obj = {};
          map.forEach((f, i) => {
            if (!f) return;
            let v = (r[i] ?? '').trim();
            if (f.type === 'ref' && v && !/^\d+$/.test(v)) v = refMaps[f.name].get(v.toLowerCase()) ?? v;
            if (f.type === 'boolean') v = /^(1|yes|true|y)$/i.test(v) ? 1 : 0;
            obj[f.name] = v;
          });
          return obj;
        });
        const res = await api('POST', `/api/data/${key}/import`, { rows: records });
        $('#imp-result', m.el).innerHTML = `<div class="pill good">${res.created} imported</div>${res.errors.length ? `<div style="margin-top:8px;max-height:200px;overflow:auto">${res.errors.map(e => `<div class="muted">⚠ ${esc(e)}</div>`).join('')}</div>` : ''}`;
        delete state.optionCache[key];
        after && after();
      } catch (e) { toast(e.message, 'error'); }
      btn.disabled = false;
    });
  }

  // ------------------------------------------------------------ profile

  function renderProfile(view) {
    setTitle('My Profile');
    const me = state.me;
    view.innerHTML = `<div class="grid two">
      <form class="card" id="prof">
        <h2>Profile</h2>
        <div class="field"><label>Photo</label>${inputFor({ name: 'avatar', type: 'image' }, me.avatar)}</div>
        <div class="field"><label>Full name</label><input name="name" value="${esc(me.name)}" required></div>
        <div class="field"><label>Email</label><input value="${esc(me.email)}" disabled></div>
        <div class="field"><label>Role</label><input value="${esc(ROLE_NAMES[me.role])}" disabled></div>
        ${me.linked ? `<div class="field"><label>Linked record</label><input value="${esc([me.linked.reg_no || me.linked.staff_no, me.linked.first_name, me.linked.last_name].join(' '))}" disabled></div>` : ''}
        <button class="btn-primary">Save profile</button>
      </form>
      <form class="card" id="pw">
        <h2>Change password</h2>
        <div class="field"><label>Current password</label><input type="password" name="current" autocomplete="current-password" required></div>
        <div class="field"><label>New password</label><input type="password" name="next" minlength="6" autocomplete="new-password" required></div>
        <div class="field"><label>Repeat new password</label><input type="password" name="again" minlength="6" autocomplete="new-password" required></div>
        <button class="btn-primary">Update password</button>
      </form></div>`;
    bindImageInputs(view);
    $('#prof').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const r = await api('PUT', '/api/me', { name: e.target.elements.name.value, avatar: e.target.elements.avatar.value });
        state.me = r.user; toast('Profile saved', 'ok'); renderShell(); route();
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#pw').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target.elements;
      if (f.next.value !== f.again.value) return toast('New passwords do not match', 'error');
      try { await api('POST', '/api/me/password', { current: f.current.value, next: f.next.value }); toast('Password changed', 'ok'); e.target.reset(); } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ------------------------------------------------------------ settings (super admin)

  const SETTINGS_TABS = [
    ['branding', '🎨 Branding & Logo'], ['general', '⚙️ General'], ['modules', '🧩 Modules & Permissions'],
    ['fields', '➕ Custom Fields'], ['data', '🗄️ Backup & Danger Zone']
  ];

  async function saveSettings(values) {
    state.settings = await api('PUT', '/api/settings', values);
    applyBranding();
    toast('Settings saved', 'ok');
  }

  function renderSettings(view, tab) {
    setTitle('Super Admin Settings');
    view.innerHTML = `<div class="tabs">${SETTINGS_TABS.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div><div id="tab"></div>`;
    const el = $('#tab', view);
    ({ branding: tabBranding, general: tabGeneral, modules: tabModules, fields: tabFields, data: tabData }[tab] || tabBranding)(el);
  }

  function imageSetting(key, label, hint) {
    const v = state.settings[key] || '';
    return `<div class="field full"><label>${esc(label)}</label>
      <div class="img-field"><img src="${esc(safeUrl(v) || '/default-logo.svg')}" data-preview alt="" style="${v ? '' : 'opacity:.3'}">
      <input type="hidden" name="${key}" value="${esc(v)}">
      <div><input type="file" accept="image/*" data-upload="${key}"><button type="button" class="btn-sm btn-ghost" data-clear="${key}">Remove</button>
      <div class="muted" style="font-size:12px">${esc(hint)}</div></div></div></div>`;
  }

  function tabBranding(el) {
    const s = state.settings;
    el.innerHTML = `<form class="card form-grid" id="brand">
      <div class="full"><h2>College identity</h2><p class="muted">Everything here appears on the login page, sidebar, browser tab and printouts.</p></div>
      ${imageSetting('logo', 'College logo', 'PNG, JPG, SVG or WEBP. Square images look best.')}
      ${imageSetting('favicon', 'Browser tab icon (favicon)', 'Leave empty to use the logo.')}
      ${imageSetting('login_background', 'Login page background image', 'Optional. A wide photo of your campus works well.')}
      <div class="field"><label>College name</label><input name="college_name" value="${esc(s.college_name)}" required></div>
      <div class="field"><label>Short name / initials</label><input name="short_name" value="${esc(s.short_name)}"></div>
      <div class="field full"><label>Tagline / motto</label><input name="tagline" value="${esc(s.tagline)}"></div>
      <div class="field"><label>Primary colour</label><input type="color" name="primary_color" value="${esc(s.primary_color || '#2952cc')}"></div>
      <div class="field"><label>Sidebar colour</label><input type="color" name="sidebar_color" value="${esc(s.sidebar_color || '#101c3d')}"></div>
      <div class="field full"><label>Login page message</label><input name="login_message" value="${esc(s.login_message)}"></div>
      <div class="field full"><label>Footer text</label><input name="footer_text" value="${esc(s.footer_text)}"></div>
      <div class="full" style="display:flex;gap:8px"><button class="btn-primary">Save branding</button><button type="button" id="reset-brand" class="btn-danger">Reset all settings to default</button></div>
    </form>`;
    bindImageInputs(el);
    const form = $('#brand', el);
    form.addEventListener('input', e => {
      if (e.target.name === 'primary_color') document.documentElement.style.setProperty('--primary', e.target.value);
      if (e.target.name === 'sidebar_color') document.documentElement.style.setProperty('--sidebar', e.target.value);
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      try { await saveSettings(values); renderShell(); route(); } catch (err) { toast(err.message, 'error'); }
    });
    $('#reset-brand', el).addEventListener('click', async () => {
      if (!await confirmDialog('Reset the logo, colours, names and all general settings back to the defaults? Module and permission changes are reset too.', { okText: 'Reset' })) return;
      state.settings = await api('POST', '/api/settings/reset');
      applyBranding(); state.meta = await api('GET', '/api/meta'); renderShell(); route();
      toast('Settings reset', 'ok');
    });
  }

  function tabGeneral(el) {
    const s = state.settings;
    const f = (k, l, type = 'text') => `<div class="field"><label>${esc(l)}</label><input type="${type}" name="${k}" value="${esc(s[k])}"></div>`;
    el.innerHTML = `<form class="card form-grid" id="gen">
      <div class="full"><h2>Contact details & system options</h2></div>
      ${f('email', 'Official email', 'email')}${f('phone', 'Phone')}${f('website', 'Website')}${f('academic_year', 'Current academic year')}
      ${f('currency', 'Currency symbol / code')}
      <div class="field"><label>Grading scale</label><input name="grading_scale" value="${esc(s.grading_scale)}"><div class="muted" style="font-size:12px">Grade:minimum %, e.g. <code>A:70, B:60, C:50, D:40, E:0</code>. Used when a grade is left blank.</div></div>
      <div class="field full"><label>Postal / physical address</label><textarea name="address">${esc(s.address)}</textarea></div>
      <div class="full"><button class="btn-primary">Save settings</button></div></form>`;
    $('#gen', el).addEventListener('submit', async e => {
      e.preventDefault();
      try { await saveSettings(Object.fromEntries(new FormData(e.target).entries())); renderShell(); route(); } catch (err) { toast(err.message, 'error'); }
    });
  }

  function tabModules(el) {
    const base = state.meta.baseEntities;
    const ents = state.meta.entities;
    const saved = (() => { try { return JSON.parse(state.settings.modules || '{}'); } catch { return {}; } })();
    const roles = ['admin', 'teacher', 'student'];
    const roleBoxes = (key, kind, current) => `<div class="roles">${roles.map(r => `<label><input type="checkbox" data-k="${key}" data-kind="${kind}" value="${r}" ${current.includes(r) ? 'checked' : ''}>${ROLE_NAMES[r]}</label>`).join('')}</div>`;
    el.innerHTML = `<div class="card">
      <h2>Modules & permissions</h2>
      <p class="muted">Rename any module, change its icon, hide it from everyone except you, and choose which roles can view or edit it. The Super Admin always has full access.</p>
      <div class="table-wrap" style="box-shadow:none"><table class="perm-table"><thead><tr><th>Icon</th><th>Menu name</th><th>Singular</th><th>Hidden</th><th>Can view</th><th>Can add / edit / delete</th><th></th></tr></thead><tbody>
      ${Object.keys(base).map(k => {
        const e = ents[k];
        return `<tr><td><input type="text" data-k="${k}" data-kind="icon" value="${esc(e.icon)}" style="width:56px;min-width:0"></td>
          <td><input type="text" data-k="${k}" data-kind="label" value="${esc(e.label)}"></td>
          <td><input type="text" data-k="${k}" data-kind="singular" value="${esc(e.singular)}"></td>
          <td><input type="checkbox" data-k="${k}" data-kind="hidden" ${e.hidden ? 'checked' : ''}></td>
          <td>${roleBoxes(k, 'read', e.read)}</td><td>${roleBoxes(k, 'write', e.write)}</td>
          <td><button class="btn-sm" data-fl="${k}">Rename fields</button></td></tr>`;
      }).join('')}</tbody></table></div>
      <div style="margin-top:14px;display:flex;gap:8px"><button class="btn-primary" id="save-mod">Save modules</button><button id="reset-mod">Restore defaults</button></div></div>`;

    const collect = () => {
      const out = {};
      for (const k of Object.keys(base)) {
        const o = { ...(saved[k] || {}) };
        const val = kind => $(`[data-k="${k}"][data-kind="${kind}"]`, el);
        o.icon = val('icon').value.trim();
        o.label = val('label').value.trim();
        o.singular = val('singular').value.trim();
        o.hidden = val('hidden').checked;
        o.read = $$(`[data-k="${k}"][data-kind="read"]:checked`, el).map(c => c.value);
        o.write = $$(`[data-k="${k}"][data-kind="write"]:checked`, el).map(c => c.value);
        out[k] = o;
      }
      return out;
    };
    const persist = async mods => {
      await saveSettings({ modules: JSON.stringify(mods) });
      state.meta = await api('GET', '/api/meta');
      renderShell(); route();
    };
    $('#save-mod', el).addEventListener('click', () => persist(collect()).catch(e => toast(e.message, 'error')));
    $('#reset-mod', el).addEventListener('click', async () => {
      if (await confirmDialog('Restore all module names, icons and permissions to the defaults?', { okText: 'Restore', danger: false })) persist({}).catch(e => toast(e.message, 'error'));
    });
    $$('[data-fl]', el).forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.fl;
      const labels = (saved[k] && saved[k].fieldLabels) || {};
      const m = modal({
        title: `Rename fields – ${ents[k].label}`,
        body: base[k].fields.map(f => `<div class="field"><label>${esc(f.name)} <span class="muted">(default: ${esc(f.label)})</span></label><input data-f="${esc(f.name)}" value="${esc(labels[f.name] || '')}" placeholder="${esc(f.label)}"></div>`).join(''),
        footer: '<button data-close>Cancel</button><button class="btn-primary" id="fl-save">Save</button>'
      });
      $('#fl-save', m.el).addEventListener('click', async () => {
        const mods = collect();
        const fl = {};
        $$('[data-f]', m.el).forEach(i => { if (i.value.trim()) fl[i.dataset.f] = i.value.trim(); });
        mods[k].fieldLabels = fl;
        m.close();
        persist(mods).catch(e => toast(e.message, 'error'));
      });
    }));
  }

  async function tabFields(el) {
    const list = await api('GET', '/api/custom-fields');
    const base = state.meta.baseEntities;
    el.innerHTML = `<div class="card">
      <div class="toolbar"><div><h2 style="margin:0">Custom fields</h2><div class="muted">Add your own fields to any module (e.g. “Blood group” on Students, “KRA PIN” on Teachers).</div></div><span class="grow"></span><button class="btn-primary" id="add-cf">＋ Add field</button></div>
      <div class="table-wrap" style="box-shadow:none"><table><thead><tr><th>Module</th><th>Label</th><th>Key</th><th>Type</th><th>Options</th><th>Required</th><th>In table</th><th></th></tr></thead><tbody>
      ${list.length ? list.map(c => `<tr><td>${esc(base[c.entity] ? base[c.entity].label : c.entity)}</td><td>${esc(c.label)}</td><td><code>${esc(c.name)}</code></td><td>${esc(c.type)}</td><td class="cell">${esc(c.options)}</td><td>${c.required ? '✔️' : ''}</td><td>${c.list ? '✔️' : ''}</td>
        <td class="actions"><button class="icon-btn" data-edit="${c.id}">✏️</button><button class="icon-btn" data-del="${c.id}">🗑</button></td></tr>`).join('') : '<tr><td colspan="8" class="empty">No custom fields yet.</td></tr>'}
      </tbody></table></div></div>`;
    const refresh = async () => { state.meta = await api('GET', '/api/meta'); tabFields(el); };
    const open = c => {
      const types = state.meta.fieldTypes;
      const m = modal({
        title: c ? 'Edit custom field' : 'New custom field',
        body: `<form class="form-grid" id="cf">
          <div class="field"><label>Module</label><select name="entity" ${c ? 'disabled' : ''}>${Object.entries(base).map(([k, b]) => `<option value="${k}" ${c && c.entity === k ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}</select></div>
          <div class="field"><label>Label</label><input name="label" required value="${esc(c ? c.label : '')}"></div>
          <div class="field"><label>Type</label><select name="type">${types.map(t => `<option ${c && c.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="field"><label>Sort order</label><input type="number" name="sort" value="${esc(c ? c.sort : 0)}"></div>
          <div class="field full"><label>Options (for “select” type, comma separated)</label><input name="options" value="${esc(c ? c.options : '')}" placeholder="A+, A-, B+, O"></div>
          <label class="check"><input type="checkbox" name="required" ${c && c.required ? 'checked' : ''}> Required</label>
          <label class="check"><input type="checkbox" name="list" ${c && c.list ? 'checked' : ''}> Show as table column</label></form>`,
        footer: '<button data-close>Cancel</button><button class="btn-primary" id="cf-save">Save</button>'
      });
      $('#cf-save', m.el).addEventListener('click', async () => {
        const f = $('#cf', m.el);
        if (!f.reportValidity()) return;
        const body = { entity: f.elements.entity.value, label: f.elements.label.value, type: f.elements.type.value, sort: f.elements.sort.value, options: f.elements.options.value, required: f.elements.required.checked, list: f.elements.list.checked };
        try {
          await api(c ? 'PUT' : 'POST', c ? `/api/custom-fields/${c.id}` : '/api/custom-fields', body);
          m.close(); toast('Field saved', 'ok'); refresh();
        } catch (e) { toast(e.message, 'error'); }
      });
    };
    $('#add-cf', el).addEventListener('click', () => open(null));
    $$('[data-edit]', el).forEach(b => b.addEventListener('click', () => open(list.find(c => String(c.id) === b.dataset.edit))));
    $$('[data-del]', el).forEach(b => b.addEventListener('click', async () => {
      if (!await confirmDialog('Delete this custom field? It will disappear from all forms and tables.')) return;
      try { await api('DELETE', `/api/custom-fields/${b.dataset.del}`); toast('Field deleted', 'ok'); refresh(); } catch (e) { toast(e.message, 'error'); }
    }));
  }

  function tabData(el) {
    const ents = state.meta.entities;
    el.innerHTML = `<div class="grid two">
      <div class="card"><h2>💾 Backup</h2><p class="muted">Download everything (records, users, settings, logo paths, custom fields) as one JSON file. Keep copies somewhere safe. Uploaded image files live in the <code>uploads/</code> folder on the server.</p>
        <a class="btn btn-primary" href="/api/backup">⬇ Download backup</a></div>
      <div class="card"><h2>♻️ Restore</h2><p class="muted">Replace <b>all</b> current data with a backup file. Everyone except you will be signed out.</p>
        <input type="file" id="restore-file" accept=".json,application/json"><div style="margin-top:10px"><button class="btn-danger" id="restore">Restore backup</button></div></div>
      <div class="card danger-zone"><h2>⚠️ Danger zone – delete all records in a module</h2>
        <p class="muted">Deletes every record in the chosen module and anything that depends on it. Super admin accounts are never deleted.</p>
        <div class="toolbar"><select id="wipe-mod" style="max-width:260px">${Object.entries(ents).map(([k, e]) => `<option value="${k}">${esc(e.label)}</option>`).join('')}</select>
        <button class="btn-danger" id="wipe">Delete all</button></div></div>
    </div>`;
    $('#restore', el).addEventListener('click', async () => {
      const file = $('#restore-file', el).files[0];
      if (!file) return toast('Choose a backup file first', 'error');
      let data;
      try { data = JSON.parse(await readFile(file, 'text')); } catch { return toast('That file is not valid JSON', 'error'); }
      if (!await confirmDialog('This will erase all current data and replace it with the backup.', { typeToConfirm: 'RESTORE', okText: 'Restore' })) return;
      try {
        await api('POST', '/api/restore', data);
        toast('Backup restored', 'ok');
        await loadSettings();
        const me = await api('GET', '/api/me').catch(() => null);
        if (!me) { state.me = null; return renderLogin(); }
        state.me = me.user; await startApp();
      } catch (e) { toast(e.message, 'error'); }
    });
    $('#wipe', el).addEventListener('click', async () => {
      const k = $('#wipe-mod', el).value;
      if (!await confirmDialog(`Delete ALL ${ents[k].label}? This cannot be undone.`, { typeToConfirm: 'DELETE', okText: 'Delete everything' })) return;
      try { const r = await api('POST', `/api/data/${k}/wipe`); toast(`${r.deleted} records deleted`, 'ok'); state.optionCache = {}; } catch (e) { toast(e.message, 'error'); }
    });
  }

  // ------------------------------------------------------------ audit log

  async function renderAudit(view, page = 1, q = '') {
    setTitle('Audit Log');
    const data = await api('GET', `/api/audit?page=${page}&q=${encodeURIComponent(q)}`);
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    view.innerHTML = `<div class="toolbar"><input class="search" type="search" placeholder="Search activity…" value="${esc(q)}"><span class="grow"></span><button class="btn-danger" id="clear">Clear log</button></div>
      <div class="table-wrap"><table><thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Module</th><th>Record</th><th>Details</th></tr></thead><tbody>
      ${data.rows.length ? data.rows.map(r => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.user_name)}</td><td><span class="pill ${r.action.includes('delete') || r.action === 'wipe' ? 'bad' : r.action === 'create' ? 'good' : ''}">${esc(r.action)}</span></td><td>${esc(r.entity)}</td><td>${r.record_id ? '#' + r.record_id : ''}</td><td class="cell" title="${esc(r.details)}">${esc(r.details)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No activity.</td></tr>'}
      </tbody></table></div>
      <div class="pager"><span class="muted">${data.total} entries</span><span>${pages > 1 ? `<button class="btn-sm" id="prev" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button> Page ${page} of ${pages} <button class="btn-sm" id="next" ${page >= pages ? 'disabled' : ''}>Next ›</button>` : ''}</span></div>`;
    let t;
    $('.search', view).addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => renderAudit(view, 1, e.target.value).then(() => { const s = $('.search', view); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }), 300); });
    $('#prev', view) && $('#prev', view).addEventListener('click', () => renderAudit(view, page - 1, q));
    $('#next', view) && $('#next', view).addEventListener('click', () => renderAudit(view, page + 1, q));
    $('#clear', view).addEventListener('click', async () => {
      if (!await confirmDialog('Clear the entire audit log?')) return;
      await api('DELETE', '/api/audit'); renderAudit(view);
    });
  }

  // ------------------------------------------------------------ boot

  (async function boot() {
    try { await loadSettings(); } catch { /* use defaults */ }
    try {
      const r = await api('GET', '/api/me');
      state.me = r.user;
      await startApp();
    } catch { renderLogin(); }
  })();
})();
