/* Booth Leads – sales staff app (offline-first). */
(function () {
  'use strict';

  var APP_VERSION = '1.0.0';
  var API_URL = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || '';
  var K = { session: 'bl.session', products: 'bl.products', leads: 'bl.leads', seq: 'bl.walkinSeq.' };
  var SYNC_BATCH = 15;

  /* ---------------------------------------------------------- storage */
  function load(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  }

  var session = load(K.session, null);
  var products = load(K.products, []);
  var leads = load(K.leads, {});   // lead_id -> lead
  function saveLeads() {
    if (!save(K.leads, leads)) toast('Warning: phone storage is full!');
  }

  /* ---------------------------------------------------------- helpers */
  function $(id) { return document.getElementById(id); }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    });
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    var s = ''; for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16); return s;
  }
  function nowIso() { return new Date().toISOString(); }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' +
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function norm(s) { return String(s || '').toLowerCase(); }
  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2600);
  }
  function walkinPrefix() {
    var digits = String(session.staff.staff_id).replace(/\D/g, '');
    return 'W' + (digits || String(session.staff.staff_id).toUpperCase()) + '-';
  }
  function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : String(n); }
  function myLeadsList() {
    var sid = session ? session.staff.staff_id : '';
    return Object.keys(leads).map(function (k) { return leads[k]; })
      .filter(function (l) { return l.staff_id === sid; });
  }

  /* -------------------------------------------------------------- API */
  function api(action, payload, timeoutMs) {
    if (!API_URL) return Promise.reject(new Error('App is not connected yet (missing API URL in config.js).'));
    var body = Object.assign({ action: action, token: session && session.token }, payload || {});
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 20000);
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        clearTimeout(timer);
        if (res && res.error === 'AUTH') { authLost(); throw new Error(res.message || 'Please log in again.'); }
        return res;
      }, function (err) { clearTimeout(timer); throw err; });
  }

  /* ------------------------------------------------------------ login */
  function showLogin() {
    $('view-app').hidden = true; $('view-login').hidden = false;
    $('login-error').hidden = true;
  }
  function authLost() {
    session = null; save(K.session, null);
    showLogin();
    var e = $('login-error'); e.textContent = 'Your session ended. Please log in again. Unsynced leads are kept on this phone.'; e.hidden = false;
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = $('login-btn'), err = $('login-error');
    err.hidden = true; btn.disabled = true; btn.textContent = 'Logging in…';
    api('login', { staff_id: $('login-id').value.trim(), pin: $('login-pin').value.trim() }, 25000)
      .then(function (res) {
        if (!res.ok) throw new Error(res.message || 'Login failed.');
        session = { token: res.token, expires_at: res.expires_at, staff: res.staff };
        save(K.session, session);
        applyBootstrap(res);
        $('login-pin').value = '';
        startApp();
        refreshFromServer();
      })
      .catch(function (e) {
        err.textContent = /abort|network|fetch|load failed/i.test(e.message) ? 'No connection. Login needs internet once.' : e.message;
        err.hidden = false;
      })
      .then(function () { btn.disabled = false; btn.textContent = 'Log in'; });
  });

  function applyBootstrap(res) {
    if (res.products) { products = res.products; save(K.products, products); renderCatChips(); }
    if (res.walkin_seq != null) {
      var key = K.seq + session.staff.staff_id;
      save(key, Math.max(Number(load(key, 0)), Number(res.walkin_seq) || 0));
      if (draft && draft.mode === 'WALKIN' && !draft.walkinExisting && !editingId) $('walkin-code').textContent = nextWalkinCode();
    }
  }

  $('logout-btn').addEventListener('click', function () {
    var pending = myLeadsList().filter(function (l) { return l._pending; }).length;
    var msg = pending
      ? pending + ' lead(s) are not synced yet. They stay on this phone and sync when you log in again. Log out?'
      : 'Log out of this phone?';
    if (!confirm(msg)) return;
    // Remove this staff's synced leads from the phone; keep unsynced ones.
    myLeadsList().forEach(function (l) { if (!l._pending) delete leads[l.lead_id]; });
    saveLeads();
    session = null; save(K.session, null);
    showLogin();
  });

  /* ------------------------------------------------------------- tabs */
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { showTab(t.dataset.tab); });
  });
  function showTab(name) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    $('tab-new').hidden = name !== 'new';
    $('tab-mine').hidden = name !== 'mine';
    if (name === 'mine') { renderMine(); refreshFromServer(); }
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------- form */
  var draft, editingId = null;
  function emptyDraft() {
    return { mode: 'REGISTERED', walkinExisting: false, customer_code: '', original_walkin_code: '', link_code: '',
      visitor_name: '', visitor_phone: '', visitor_brand: '', items: [], lead_temp: '', next_action: '', notes: '' };
  }

  function nextWalkinCode() {
    var n = Number(load(K.seq + session.staff.staff_id, 0)) + 1;
    return walkinPrefix() + pad3(n);
  }
  function reserveWalkinCode(code) {
    var n = Number(code.slice(walkinPrefix().length));
    var key = K.seq + session.staff.staff_id;
    if (n > Number(load(key, 0))) save(key, n);
  }

  function setMode(mode) {
    draft.mode = mode;
    document.querySelectorAll('#mode-seg button').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
    $('mode-registered').hidden = mode !== 'REGISTERED';
    $('mode-walkin').hidden = mode !== 'WALKIN';
    $('walkin-new').hidden = draft.walkinExisting;
    $('walkin-existing').hidden = !draft.walkinExisting;
    if (mode === 'WALKIN' && !draft.walkinExisting && !editingId) $('walkin-code').textContent = nextWalkinCode();
    $('name-label').textContent = mode === 'WALKIN' ? 'Visitor name (required)' : 'Visitor name';
    $('history').hidden = true;
    var code = currentCode();
    if (code) lookupCode(code);
  }
  document.querySelectorAll('#mode-seg button').forEach(function (b) {
    b.addEventListener('click', function () { if (!editingId) setMode(b.dataset.mode); });
  });
  $('walkin-existing-btn').addEventListener('click', function () { draft.walkinExisting = true; setMode('WALKIN'); $('walkin-code-input').focus(); });
  $('walkin-new-btn').addEventListener('click', function () { draft.walkinExisting = false; $('walkin-code-input').value = ''; setMode('WALKIN'); });

  function currentCode() {
    if (draft.mode === 'REGISTERED') {
      var c = $('code').value.trim();
      return /^\d{5}$/.test(c) ? c : '';
    }
    if (editingId) return draft.customer_code;
    if (draft.walkinExisting) {
      var w = $('walkin-code-input').value.trim().toUpperCase();
      return /^W[0-9A-Z]+-\d{1,4}$/.test(w) ? w : '';
    }
    return '';
  }

  $('code').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 5);
    $('history').hidden = true;
    if (this.value.length === 5) lookupCode(this.value);
  });
  $('walkin-code-input').addEventListener('input', function () {
    this.value = this.value.toUpperCase().replace(/[^0-9A-Z-]/g, '');
    $('history').hidden = true;
    var c = currentCode(); if (c) lookupCode(c);
  });
  $('link-code-input').addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 5);
  });

  var lookupSeq = 0;
  function lookupCode(code) {
    var mySeq = ++lookupSeq;
    // Local history first (works offline).
    var local = Object.keys(leads).map(function (k) { return leads[k]; })
      .filter(function (l) { return l.lead_id !== editingId && (l.customer_code === code || l.original_walkin_code === code); })
      .map(function (l) {
        return { visitor_name: l.visitor_name, visitor_brand: l.visitor_brand, visitor_phone: l.visitor_phone, staff_name: l.staff_name,
          created_at: l.created_at, lead_temp: l.lead_temp, notes: l.notes, products: (l.items || []).map(function (i) { return i.product_name || i.product_code; }) };
      });
    showHistory(code, local, navigator.onLine ? 'Checking earlier visits…' : 'Offline — showing visits saved on this phone only.');
    api('lookup', { code: code }, 7000).then(function (res) {
      if (mySeq !== lookupSeq || !res.ok) return;
      showHistory(code, res.history && res.history.length ? res.history : local, '');
    }).catch(function () {
      if (mySeq !== lookupSeq) return;
      showHistory(code, local, 'Could not check online — showing visits saved on this phone only.');
    });
  }
  function showHistory(code, list, note) {
    var box = $('history'); box.innerHTML = '';
    if (!list.length && !note) { box.appendChild(h('div', { text: 'First visit for ' + code + '.' })); box.hidden = false; return; }
    if (list.length) {
      box.appendChild(h('strong', { text: 'Seen before · ' + list.length + ' visit' + (list.length > 1 ? 's' : '') }));
      list.slice(0, 5).forEach(function (v) {
        box.appendChild(h('div', { class: 'h-item' }, [
          h('div', { text: [v.visitor_name, v.visitor_brand].filter(Boolean).join(' · ') || '(no name)' }),
          h('div', { class: 'muted small', text: fmtTime(v.created_at) + ' · ' + (v.staff_name || '') + (v.lead_temp ? ' · ' + v.lead_temp : '') }),
          v.products && v.products.length ? h('div', { class: 'small', text: 'Products: ' + v.products.join(', ') }) : null,
          v.notes ? h('div', { class: 'small', text: '“' + v.notes + '”' }) : null
        ]));
      });
      // Pre-fill visitor details from the latest visit if the fields are empty.
      var latest = list[0];
      [['visitor_name', latest.visitor_name], ['visitor_brand', latest.visitor_brand], ['visitor_phone', latest.visitor_phone]].forEach(function (p) {
        if (p[1] && !$(p[0]).value) $(p[0]).value = p[1];
      });
    }
    if (note) box.appendChild(h('div', { class: 'muted small', text: note }));
    box.hidden = false;
  }

  /* --------------------------------------------------------- products */
  var activeCat = '';
  function renderCatChips() {
    var cats = [];
    products.forEach(function (p) { if (p.category && cats.indexOf(p.category) === -1) cats.push(p.category); });
    cats.sort();
    var box = $('cat-chips'); box.innerHTML = '';
    if (!cats.length) return;
    [''].concat(cats).forEach(function (c) {
      box.appendChild(h('button', { type: 'button', class: 'chip' + (c === activeCat ? ' on' : ''), text: c || 'All',
        onclick: function () { activeCat = c === activeCat ? '' : c; renderCatChips(); renderResults(); } }));
    });
  }
  $('product-search').addEventListener('input', renderResults);

  function renderResults() {
    var q = norm($('product-search').value).trim();
    var box = $('product-results'); box.innerHTML = '';
    if (!q && !activeCat) return;
    var words = q.split(/\s+/).filter(Boolean);
    var hits = products.filter(function (p) {
      if (activeCat && p.category !== activeCat) return false;
      var hay = norm(p.product_code + ' ' + p.product_name + ' ' + p.product_SKU + ' ' + p.category);
      return words.every(function (w) { return hay.indexOf(w) !== -1; });
    });
    var limit = q ? 15 : 60;
    hits.slice(0, limit).forEach(function (p) {
      var added = draft.items.some(function (i) { return i.product_code === p.product_code; });
      box.appendChild(h('button', { type: 'button', class: 'result' + (added ? ' added' : ''), onclick: function () { addItem(p); } }, [
        h('div', null, [
          h('div', { class: 'r-main', text: p.product_name || p.product_code }),
          h('div', { class: 'r-sub', text: [p.product_code, p.product_SKU && 'SKU ' + p.product_SKU, p.category].filter(Boolean).join(' · ') })
        ]),
        h('span', { class: 'plus', text: added ? '✓' : '+' })
      ]));
    });
    if (hits.length > limit) box.appendChild(h('div', { class: 'muted small', text: (hits.length - limit) + ' more — keep typing to narrow down.' }));
    if (q && !hits.length) {
      var raw = $('product-search').value.trim();
      box.appendChild(h('div', { class: 'muted small', text: products.length ? 'No product matches “' + raw + '”.' : 'Product list not loaded yet (needs internet once).' }));
      box.appendChild(h('button', { type: 'button', class: 'btn ghost small', text: 'Add “' + raw + '” as a custom item',
        onclick: function () { addItem({ product_code: raw.toUpperCase(), product_name: raw, product_SKU: '', category: 'Custom' }); } }));
    }
  }

  function addItem(p) {
    if (draft.items.some(function (i) { return i.product_code === p.product_code; })) { toast('Already added'); return; }
    draft.items.push({ product_code: p.product_code, product_name: p.product_name, product_SKU: p.product_SKU || '', category: p.category || '',
      interest_level: 'Medium', sample_given: false, sample_qty: 0 });
    $('product-search').value = '';
    renderResults(); renderItems();
  }

  function renderItems() {
    var box = $('items'); box.innerHTML = '';
    draft.items.forEach(function (it, idx) {
      var seg = h('div', { class: 'seg mini' }, ['High', 'Medium', 'Low'].map(function (lvl) {
        return h('button', { type: 'button', class: it.interest_level === lvl ? 'on' : '', text: lvl,
          onclick: function () { it.interest_level = lvl; renderItems(); } });
      }));
      var chk = h('input', { type: 'checkbox', checked: it.sample_given,
        onchange: function () { it.sample_given = this.checked; it.sample_qty = this.checked ? (it.sample_qty || 1) : 0; renderItems(); } });
      var qty = it.sample_given ? h('div', { class: 'qty' }, [
        h('button', { type: 'button', text: '−', 'aria-label': 'Less', onclick: function () { it.sample_qty = Math.max(1, it.sample_qty - 1); renderItems(); } }),
        h('span', { text: String(it.sample_qty) }),
        h('button', { type: 'button', text: '+', 'aria-label': 'More', onclick: function () { it.sample_qty = Math.min(99, it.sample_qty + 1); renderItems(); } })
      ]) : null;
      box.appendChild(h('div', { class: 'item' }, [
        h('div', { class: 'item-head' }, [
          h('div', null, [
            h('div', { class: 'item-title', text: it.product_name || it.product_code }),
            h('div', { class: 'item-sub', text: [it.product_code, it.product_SKU && 'SKU ' + it.product_SKU, it.category].filter(Boolean).join(' · ') })
          ]),
          h('button', { type: 'button', class: 'remove', 'aria-label': 'Remove', text: '×', onclick: function () { draft.items.splice(idx, 1); renderItems(); renderResults(); } })
        ]),
        h('div', { class: 'item-row' }, [seg]),
        h('div', { class: 'item-row' }, [h('label', { class: 'check' }, [chk, 'Sample given']), qty])
      ]));
    });
  }

  /* ------------------------------------------------------ temp & save */
  document.querySelectorAll('#temp-seg button').forEach(function (b) {
    b.addEventListener('click', function () { draft.lead_temp = b.dataset.temp; renderTemp(); });
  });
  function renderTemp() {
    document.querySelectorAll('#temp-seg button').forEach(function (b) { b.classList.toggle('on', b.dataset.temp === draft.lead_temp); });
  }

  function formError(msg) {
    var e = $('form-error'); e.textContent = msg; e.hidden = !msg;
    if (msg) e.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('save-btn').addEventListener('click', function () {
    formError('');
    var lead;
    var vname = $('visitor_name').value.trim();
    var base = {
      visitor_name: vname, visitor_phone: $('visitor_phone').value.trim(), visitor_brand: $('visitor_brand').value.trim(),
      lead_temp: draft.lead_temp, next_action: $('next_action').value, notes: $('notes').value.trim(),
      items: draft.items.map(function (i) { return Object.assign({}, i); })
    };

    if (editingId) {
      var old = leads[editingId];
      lead = Object.assign({}, old, base);
      if (old.code_type === 'REGISTERED') {
        var c = $('code').value.trim();
        if (!/^\d{5}$/.test(c)) return formError('Customer code must be 5 digits.');
        lead.customer_code = c;
      }
      var link = $('link-code-input').value.trim();
      if (old.code_type === 'WALKIN' && link) {
        if (!/^\d{5}$/.test(link)) return formError('Registered code must be 5 digits.');
        lead.original_walkin_code = old.customer_code;
        lead.customer_code = link;
        lead.code_type = 'REGISTERED';
        // Keep this phone's other leads for the same walk-in in step (server does the same).
        Object.keys(leads).forEach(function (k) {
          var l = leads[k];
          if (k !== editingId && l.customer_code === old.customer_code) {
            l.original_walkin_code = old.customer_code; l.customer_code = link; l.code_type = 'REGISTERED';
          }
        });
      }
      if (lead.code_type === 'WALKIN' && !vname) return formError('Walk-in visitors need a name.');
      if (!lead.lead_temp) return formError('Choose a lead temperature (Hot / Warm / Cold).');
      lead.updated_at = nowIso();
      lead._pending = true; delete lead._error;
    } else {
      var code, type = draft.mode;
      if (type === 'REGISTERED') {
        code = currentCode();
        if (!code) return formError('Enter the 5-digit customer code, or switch to Walk-in.');
      } else {
        if (!vname) return formError('Walk-in visitors need a name.');
        if (draft.walkinExisting) {
          code = currentCode();
          if (!code) return formError('Enter the walk-in code, e.g. ' + walkinPrefix() + '001.');
        } else {
          code = nextWalkinCode();
          reserveWalkinCode(code);
        }
      }
      if (!draft.lead_temp) return formError('Choose a lead temperature (Hot / Warm / Cold).');
      var t = nowIso();
      lead = Object.assign(base, {
        lead_id: uuid(), customer_code: code, code_type: type, original_walkin_code: '',
        staff_id: session.staff.staff_id, staff_name: session.staff.name,
        created_at: t, updated_at: t, edit_count: 0, _pending: true
      });
    }

    leads[lead.lead_id] = lead;
    saveLeads();
    var wasEdit = !!editingId;
    toast(wasEdit ? 'Changes saved ✓' : (lead.code_type === 'WALKIN' ? 'Saved ✓  Code ' + lead.customer_code : 'Saved ✓  ' + lead.customer_code), 3200);
    resetForm();
    updateSyncPill();
    syncNow();
    if (wasEdit) showTab('mine');
  });

  $('cancel-edit').addEventListener('click', function () { resetForm(); showTab('mine'); });

  function resetForm() {
    editingId = null;
    draft = emptyDraft();
    ['code', 'walkin-code-input', 'link-code-input', 'visitor_name', 'visitor_phone', 'visitor_brand', 'notes', 'product-search'].forEach(function (id) { $(id).value = ''; });
    $('next_action').value = '';
    $('edit-banner').hidden = true;
    $('cancel-edit').hidden = true;
    $('link-code').hidden = true;
    $('walkin-existing-btn').hidden = false;
    $('save-btn').textContent = 'Save lead';
    $('mode-seg').hidden = false;
    $('code').disabled = false;
    formError('');
    activeCat = ''; renderCatChips();
    setMode('REGISTERED');
    renderItems(); renderResults(); renderTemp();
    window.scrollTo(0, 0);
  }

  function editLead(id) {
    var l = leads[id]; if (!l) return;
    resetForm();
    editingId = id;
    draft = Object.assign(emptyDraft(), {
      mode: l.code_type, walkinExisting: false, customer_code: l.customer_code, lead_temp: l.lead_temp,
      items: (l.items || []).map(function (i) { return Object.assign({}, i); })
    });
    setMode(l.code_type);
    $('mode-seg').hidden = true;
    if (l.code_type === 'REGISTERED') {
      $('code').value = l.customer_code;
    } else {
      $('walkin-code').textContent = l.customer_code;
      $('walkin-existing-btn').hidden = true;
      $('link-code').hidden = false;
    }
    $('visitor_name').value = l.visitor_name || '';
    $('visitor_phone').value = l.visitor_phone || '';
    $('visitor_brand').value = l.visitor_brand || '';
    $('next_action').value = l.next_action || '';
    $('notes').value = l.notes || '';
    renderItems(); renderTemp();
    var b = $('edit-banner');
    b.innerHTML = '';
    b.appendChild(h('strong', { text: 'Editing lead ' + l.customer_code }));
    b.appendChild(h('div', { class: 'small', text: 'Created ' + fmtTime(l.created_at) +
      (l.edit_count ? ' · edited ' + l.edit_count + ' time' + (l.edit_count > 1 ? 's' : '') : '') +
      (l.updated_at && l.updated_at !== l.created_at ? ' · last change ' + fmtTime(l.updated_at) : '') +
      (l.original_walkin_code ? ' · was walk-in ' + l.original_walkin_code : '') }));
    b.hidden = false;
    $('cancel-edit').hidden = false;
    $('save-btn').textContent = 'Save changes';
    $('history').hidden = true;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === 'new'); });
    $('tab-new').hidden = false; $('tab-mine').hidden = true;
    window.scrollTo(0, 0);
  }

  /* --------------------------------------------------------- my leads */
  $('mine-search').addEventListener('input', renderMine);
  function renderMine() {
    var q = norm($('mine-search').value).trim();
    var list = myLeadsList().sort(function (a, b) { return b.created_at < a.created_at ? -1 : 1; });
    $('mine-count').textContent = list.length || '';
    if (q) list = list.filter(function (l) {
      var hay = norm([l.customer_code, l.original_walkin_code, l.visitor_name, l.visitor_brand, l.notes]
        .concat((l.items || []).map(function (i) { return i.product_code + ' ' + i.product_name; })).join(' '));
      return hay.indexOf(q) !== -1;
    });
    var box = $('mine-list'); box.innerHTML = '';
    if (!list.length) { box.appendChild(h('div', { class: 'empty', text: q ? 'No matching leads.' : 'No leads yet. They appear here after you save one.' })); return; }
    list.forEach(function (l) {
      var status = l._error ? ['error', 'Not synced: ' + l._error] : l._pending ? ['pending', 'Waiting to sync'] : ['synced', 'Synced ✓'];
      var samples = (l.items || []).filter(function (i) { return i.sample_given; }).length;
      box.appendChild(h('button', { type: 'button', class: 'lead', onclick: function () { editLead(l.lead_id); } }, [
        h('div', { class: 'lead-top' }, [
          h('span', { class: 'lead-code', text: l.customer_code }),
          l.lead_temp ? h('span', { class: 'badge ' + l.lead_temp, text: l.lead_temp }) : null
        ]),
        h('div', { class: 'lead-name', text: [l.visitor_name, l.visitor_brand].filter(Boolean).join(' · ') || '(no name)' }),
        h('div', { class: 'lead-meta', text: (l.items || []).length + ' product(s)' + (samples ? ' · ' + samples + ' sample(s)' : '') +
          ' · ' + fmtTime(l.created_at) + (l.edit_count ? ' · edited ' + l.edit_count + '×' : '') }),
        h('div', { class: 'status ' + status[0], text: status[1] })
      ]));
    });
  }

  /* ------------------------------------------------------------- sync */
  var syncing = false, lastSyncFailed = false;
  function pendingLeads() { return myLeadsList().filter(function (l) { return l._pending; }); }

  function updateSyncPill() {
    var p = $('sync-pill'), n = pendingLeads().length;
    var errs = myLeadsList().filter(function (l) { return l._error; }).length;
    p.className = 'sync-pill' + (errs ? ' error' : n ? ' pending' : '');
    if (syncing) p.textContent = '↻ Syncing ' + n + '…';
    else if (errs) p.textContent = '⚠ ' + errs + ' not synced — tap';
    else if (n) p.textContent = (lastSyncFailed ? 'Offline · ' : '') + n + ' saved on phone, waiting';
    else p.textContent = '✓ All synced';
  }
  $('sync-pill').addEventListener('click', function () { syncNow(true); });

  function syncNow(manual) {
    if (syncing || !session) return;
    var batch = pendingLeads().slice(0, SYNC_BATCH);
    if (!batch.length) { if (manual) toast('Everything is synced ✓'); updateSyncPill(); return; }
    syncing = true; updateSyncPill();
    var sent = {};
    var payload = batch.map(function (l) {
      sent[l.lead_id] = l.updated_at;
      var o = {}; Object.keys(l).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = l[k]; }); return o;
    });
    api('sync', { leads: payload }, 30000).then(function (res) {
      if (!res.ok) throw new Error(res.message || 'Sync failed');
      lastSyncFailed = false;
      (res.results || []).forEach(function (r) {
        var l = leads[r.lead_id]; if (!l) return;
        if (r.status === 'error') { l._error = r.message || 'error'; return; }
        if (r.edit_count != null) l.edit_count = r.edit_count;
        delete l._error;
        if (l.updated_at === sent[r.lead_id]) l._pending = false; // not edited again while sending
      });
      saveLeads();
      syncing = false;
      var more = pendingLeads().filter(function (l) { return !l._error; }).length;
      if (more) setTimeout(syncNow, 300);
      else if (manual) toast('Synced ✓');
    }).catch(function (e) {
      syncing = false; lastSyncFailed = true;
      if (manual) toast(/abort|network|fetch|load failed/i.test(e.message) ? 'No connection — leads are safe on this phone.' : e.message, 3500);
    }).then(function () {
      updateSyncPill();
      if (!$('tab-mine').hidden) renderMine(); else $('mine-count').textContent = myLeadsList().length || '';
    });
  }

  /** Pull this staff's leads + product list from the server (fills a new phone, picks up relinks). */
  function refreshFromServer() {
    if (!session) return;
    api('bootstrap', {}, 20000).then(function (res) { if (res.ok) applyBootstrap(res); }).catch(function () {});
    api('myLeads', {}, 25000).then(function (res) {
      if (!res.ok) return;
      (res.leads || []).forEach(function (s) {
        var l = leads[s.lead_id];
        if (l && l._pending) return; // local unsynced changes win
        s._pending = false;
        leads[s.lead_id] = s;
      });
      saveLeads();
      if (!$('tab-mine').hidden) renderMine(); else $('mine-count').textContent = myLeadsList().length || '';
      updateSyncPill();
    }).catch(function () {});
  }

  window.addEventListener('online', function () { syncNow(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) syncNow(); });
  setInterval(function () { if (pendingLeads().length) syncNow(); }, 20000);

  /* ------------------------------------------------------------ start */
  function startApp() {
    $('view-login').hidden = true; $('view-app').hidden = false;
    $('who').textContent = session.staff.name + ' · ' + session.staff.staff_id;
    $('walkin-existing-btn').hidden = false;
    resetForm();
    renderCatChips();
    $('mine-count').textContent = myLeadsList().length || '';
    updateSyncPill();
    syncNow();
  }

  draft = emptyDraft();
  if (session && session.token && session.expires_at > Date.now()) {
    startApp();
    refreshFromServer();
  } else {
    if (session) { session = null; save(K.session, null); }
    showLogin();
    if (!API_URL) { var e = $('login-error'); e.textContent = 'Setup not finished: API URL missing in config.js.'; e.hidden = false; }
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  window.__BOOTH_LEADS_VERSION = APP_VERSION;
})();
