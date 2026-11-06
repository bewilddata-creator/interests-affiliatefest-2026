/**
 * Interests – Affiliate Fest 2026 · Sales leads backend
 *
 * Paste this whole file into Extensions → Apps Script of the leads Google Sheet.
 * Run `setup` once, then Deploy → New deployment → Web app
 *   (Execute as: Me, Who has access: Anyone).
 *
 * The phone app talks to this script with POST requests (Content-Type: text/plain)
 * whose body is JSON: { action: "...", token: "...", ... }.
 */

var TOKEN_DAYS = 30;          // staff stay logged in this long
var MAX_LOGIN_FAILS = 5;      // wrong PINs before a temporary lock
var LOCK_MINUTES = 10;

var TABS = {
  Staff: ['staff_id', 'name', 'pin', 'active'],
  Products: ['product_code', 'product_name', 'product_SKU', 'main_category', 'category', 'active'],
  Leads: ['lead_id', 'customer_code', 'code_type', 'original_walkin_code', 'visitor_name',
    'visitor_phone', 'visitor_brand', 'staff_id', 'staff_name', 'lead_temp', 'next_action',
    'samples_given', 'notes', 'created_at', 'updated_at', 'received_at', 'edit_count'],
  LeadItems: ['lead_id', 'customer_code', 'product_code', 'product_name', 'product_SKU',
    'main_category', 'category', 'interest_level', 'staff_id', 'updated_at'],
  EditLog: ['logged_at', 'lead_id', 'staff_id', 'field', 'old_value', 'new_value']
};

// Columns that must stay as text so leading zeros survive (e.g. code 01234, PIN 0420).
var TEXT_COLUMNS = {
  Staff: ['staff_id', 'pin'],
  Products: ['product_code', 'product_SKU'],
  Leads: ['lead_id', 'customer_code', 'original_walkin_code', 'visitor_phone', 'staff_id'],
  LeadItems: ['lead_id', 'customer_code', 'product_code', 'product_SKU', 'staff_id'],
  EditLog: ['lead_id', 'staff_id', 'old_value', 'new_value']
};

// Lead fields the phone may send; compared on edit to fill the EditLog.
var LEAD_FIELDS = ['customer_code', 'code_type', 'original_walkin_code', 'visitor_name',
  'visitor_phone', 'visitor_brand', 'lead_temp', 'next_action', 'samples_given', 'notes'];

/* ------------------------------------------------------------------ setup */

/** Run once from the Apps Script editor. Safe to run again. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var lastCol = sh.getLastColumn();
    var headers = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    TABS[name].forEach(function (h) {
      if (headers.indexOf(h) === -1) {
        headers.push(h);
        sh.getRange(1, headers.length).setValue(h);
      }
    });
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    (TEXT_COLUMNS[name] || []).forEach(function (h) {
      var col = headers.indexOf(h) + 1;
      sh.getRange(2, col, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });
  getSecret_();
  Logger.log('Setup done. Spreadsheet time zone: ' + ss.getSpreadsheetTimeZone());
}

/** Run this to log every phone out immediately (they must log in again). */
function logoutEveryone() {
  PropertiesService.getScriptProperties().setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  Logger.log('All sessions revoked.');
}

/* ------------------------------------------------------------- web entry */

function doGet() {
  return json_({ ok: true, service: 'interests-affiliatefest-2026', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action;
    if (action === 'login') return json_(login_(body));
    var staff = verifyToken_(body.token);
    if (!staff) return json_({ ok: false, error: 'AUTH', message: 'Please log in again.' });
    if (action === 'bootstrap') return json_(bootstrap_(staff));
    if (action === 'products') return json_({ ok: true, products: getProducts_() });
    if (action === 'sync') return json_(sync_(staff, body.leads || []));
    if (action === 'myLeads') return json_({ ok: true, leads: myLeads_(staff) });
    if (action === 'lookup') return json_({ ok: true, history: lookup_(body.code) });
    return json_({ ok: false, error: 'BAD_ACTION' });
  } catch (err) {
    return json_({ ok: false, error: 'SERVER', message: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ auth */

function login_(body) {
  var id = String(body.staff_id || '').trim().toUpperCase();
  var pin = String(body.pin || '').trim();
  if (!id || !pin) return { ok: false, error: 'LOGIN', message: 'Enter your Staff ID and PIN.' };

  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + id;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_LOGIN_FAILS) {
    return { ok: false, error: 'LOCKED', message: 'Too many wrong PINs. Try again in ' + LOCK_MINUTES + ' minutes.' };
  }

  var staff = findStaff_(id);
  if (!staff || !pinMatches_(staff.pin, pin)) {
    cache.put(failKey, String(fails + 1), LOCK_MINUTES * 60);
    return { ok: false, error: 'LOGIN', message: 'Wrong Staff ID or PIN.' };
  }
  if (!staff.active) return { ok: false, error: 'INACTIVE', message: 'This account is not active.' };
  cache.remove(failKey);

  var exp = Date.now() + TOKEN_DAYS * 24 * 3600 * 1000;
  var out = bootstrap_(staff);
  out.token = signToken_(staff.staff_id, exp);
  out.expires_at = exp;
  return out;
}

function bootstrap_(staff) {
  return {
    ok: true,
    staff: { staff_id: staff.staff_id, name: staff.name },
    products: getProducts_(),
    walkin_seq: maxWalkinSeq_(staff.staff_id)
  };
}

function pinMatches_(sheetPin, pin) {
  var a = String(sheetPin).trim();
  if (a === pin) return true;
  // PIN typed into a number-formatted cell may have lost leading zeros.
  return /^\d+$/.test(a) && /^\d+$/.test(pin) && Number(a) === Number(pin) && a.length < pin.length;
}

function findStaff_(id) {
  var rows = readTable_('Staff');
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.staff_id).trim().toUpperCase() === id) {
      return { staff_id: String(r.staff_id).trim(), name: String(r.name || '').trim(), pin: r.pin, active: isTrue_(r.active) };
    }
  }
  return null;
}

function getSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', s);
  }
  return s;
}

function sign_(payload) {
  var bytes = Utilities.computeHmacSha256Signature(payload, getSecret_());
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function signToken_(staffId, exp) {
  var payload = staffId + '|' + exp;
  return Utilities.base64EncodeWebSafe(payload).replace(/=+$/, '') + '.' + sign_(payload);
}

/** Returns the staff record if the token is valid, unexpired and the staff is still active. */
function verifyToken_(token) {
  if (!token || String(token).indexOf('.') === -1) return null;
  var parts = String(token).split('.');
  var payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(padB64_(parts[0]))).getDataAsString();
  } catch (e) { return null; }
  if (sign_(payload) !== parts[1]) return null;
  var bits = payload.split('|');
  if (Number(bits[1]) < Date.now()) return null;
  var staff = findStaff_(String(bits[0]).toUpperCase());
  return staff && staff.active ? staff : null;
}

function padB64_(s) {
  while (s.length % 4) s += '=';
  return s;
}

/* -------------------------------------------------------------- products */

function getProducts_() {
  return readTable_('Products')
    .filter(function (r) { return String(r.product_code).trim() && (r.active === '' || isTrue_(r.active)); })
    .map(function (r) {
      return {
        product_code: String(r.product_code).trim(),
        product_name: String(r.product_name || '').trim(),
        product_SKU: String(r.product_SKU || '').trim(),
        main_category: String(r.main_category || '').trim(),
        category: String(r.category || '').trim()
      };
    });
}

/* ----------------------------------------------------------------- leads */

function sync_(staff, leads) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    // New columns added in an update: create them automatically if setup was not re-run.
    var missing = ['Leads', 'LeadItems', 'EditLog'].some(function (n) {
      var sh = ss.getSheetByName(n);
      if (!sh || !sh.getLastColumn()) return true;
      var hdr = headers_(sh);
      return TABS[n].some(function (h) { return hdr.indexOf(h) === -1; });
    });
    if (missing) setup();
    var leadSh = ss.getSheetByName('Leads');
    var itemSh = ss.getSheetByName('LeadItems');
    var logSh = ss.getSheetByName('EditLog');
    var leadHdr = headers_(leadSh);
    var itemHdr = headers_(itemSh);
    var logHdr = headers_(logSh);
    var now = new Date();
    var results = [];

    leads.forEach(function (lead) {
      try {
        results.push(upsertLead_(staff, lead, leadSh, itemSh, logSh, leadHdr, itemHdr, logHdr, now));
      } catch (err) {
        results.push({ lead_id: lead && lead.lead_id, status: 'error', message: String(err && err.message || err) });
      }
    });
    SpreadsheetApp.flush();
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

function upsertLead_(staff, lead, leadSh, itemSh, logSh, leadHdr, itemHdr, logHdr, now) {
  var id = String(lead.lead_id || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return { lead_id: id, status: 'error', message: 'Bad lead_id' };

  var clean = cleanLead_(lead);
  var items = (lead.items || []).map(cleanItem_);
  var rowNum = findRow_(leadSh, leadHdr, 'lead_id', id);

  if (!rowNum) {
    var rec = {};
    LEAD_FIELDS.forEach(function (f) { rec[f] = clean[f]; });
    rec.lead_id = id;
    rec.staff_id = staff.staff_id;
    rec.staff_name = staff.name;
    rec.created_at = toDate_(lead.created_at) || now;
    rec.updated_at = toDate_(lead.updated_at) || now;
    rec.received_at = now;
    rec.edit_count = 0;
    appendObj_(leadSh, leadHdr, rec);
    writeItems_(itemSh, itemHdr, id, rec.customer_code, staff.staff_id, rec.updated_at, items);
    return { lead_id: id, status: 'created', edit_count: 0 };
  }

  var width = leadHdr.length;
  var oldRow = leadSh.getRange(rowNum, 1, 1, width).getValues()[0];
  var old = rowToObj_(leadHdr, oldRow);
  if (String(old.staff_id).trim().toUpperCase() !== staff.staff_id.toUpperCase()) {
    return { lead_id: id, status: 'error', message: 'This lead belongs to another staff member.' };
  }
  var incomingUpdated = toDate_(lead.updated_at) || now;
  var oldUpdated = toDate_(old.updated_at);
  // Same or older version (e.g. a retry after a dropped connection): nothing to do.
  if (oldUpdated && incomingUpdated.getTime() <= oldUpdated.getTime() + 1000) {
    return { lead_id: id, status: 'unchanged', edit_count: Number(old.edit_count || 0) };
  }

  var changes = [];
  LEAD_FIELDS.forEach(function (f) {
    var before = f === 'samples_given' ? String(isTrue_(old[f])) : String(old[f] == null ? '' : old[f]);
    var after = String(clean[f]);
    if (before !== after) changes.push([f, before, after]);
  });
  var oldItemsText = itemsSummary_(readItems_(itemSh, itemHdr, id));
  var newItemsText = itemsSummary_(items);
  if (oldItemsText !== newItemsText) changes.push(['products', oldItemsText, newItemsText]);

  var editCount = Number(old.edit_count || 0);
  if (changes.length) {
    editCount += 1;
    LEAD_FIELDS.forEach(function (f) { old[f] = clean[f]; });
    old.updated_at = incomingUpdated;
    old.received_at = now;
    old.edit_count = editCount;
    leadSh.getRange(rowNum, 1, 1, width).setValues([objToRow_(leadHdr, old, oldRow)]);
    deleteItems_(itemSh, itemHdr, id);
    writeItems_(itemSh, itemHdr, id, clean.customer_code, staff.staff_id, incomingUpdated, items);
    changes.forEach(function (c) {
      appendObj_(logSh, logHdr, { logged_at: now, lead_id: id, staff_id: staff.staff_id, field: c[0], old_value: c[1], new_value: c[2] });
    });
  }

  // A walk-in who registered later: move every other lead with the old W-code to the new code.
  if (clean.original_walkin_code && clean.code_type === 'REGISTERED' && clean.customer_code) {
    relinkWalkin_(leadSh, itemSh, logSh, leadHdr, itemHdr, logHdr, clean.original_walkin_code, clean.customer_code, staff, now);
  }
  return { lead_id: id, status: changes.length ? 'updated' : 'unchanged', edit_count: editCount };
}

function relinkWalkin_(leadSh, itemSh, logSh, leadHdr, itemHdr, logHdr, wCode, newCode, staff, now) {
  var last = leadSh.getLastRow();
  if (last < 2) return;
  var codeCol = leadHdr.indexOf('customer_code');
  var typeCol = leadHdr.indexOf('code_type');
  var origCol = leadHdr.indexOf('original_walkin_code');
  var idCol = leadHdr.indexOf('lead_id');
  var data = leadSh.getRange(2, 1, last - 1, leadHdr.length).getValues();
  var moved = {};
  data.forEach(function (row, i) {
    if (String(row[codeCol]).trim() === wCode) {
      row[codeCol] = newCode;
      row[typeCol] = 'REGISTERED';
      row[origCol] = wCode;
      leadSh.getRange(i + 2, 1, 1, leadHdr.length).setValues([row]);
      moved[String(row[idCol])] = true;
      appendObj_(logSh, logHdr, { logged_at: now, lead_id: String(row[idCol]), staff_id: staff.staff_id, field: 'customer_code', old_value: wCode, new_value: newCode });
    }
  });
  var iLast = itemSh.getLastRow();
  if (iLast < 2) return;
  var iCode = itemHdr.indexOf('customer_code');
  var iId = itemHdr.indexOf('lead_id');
  var items = itemSh.getRange(2, 1, iLast - 1, itemHdr.length).getValues();
  items.forEach(function (row, i) {
    if (String(row[iCode]).trim() === wCode || moved[String(row[iId])]) {
      if (String(row[iCode]).trim() !== newCode) {
        itemSh.getRange(i + 2, iCode + 1).setValue(newCode);
      }
    }
  });
}

function myLeads_(staff) {
  var sid = staff.staff_id.toUpperCase();
  var leads = readTable_('Leads').filter(function (r) { return String(r.staff_id).trim().toUpperCase() === sid; });
  var byId = {};
  leads.forEach(function (r) { byId[String(r.lead_id)] = []; });
  readTable_('LeadItems').forEach(function (it) {
    var list = byId[String(it.lead_id)];
    if (list) list.push(cleanItem_(it));
  });
  return leads.map(function (r) {
    var o = {};
    LEAD_FIELDS.forEach(function (f) { o[f] = String(r[f] == null ? '' : r[f]); });
    o.samples_given = isTrue_(r.samples_given);
    o.lead_id = String(r.lead_id);
    o.staff_id = String(r.staff_id);
    o.staff_name = String(r.staff_name || '');
    o.created_at = isoOrEmpty_(r.created_at);
    o.updated_at = isoOrEmpty_(r.updated_at);
    o.received_at = isoOrEmpty_(r.received_at);
    o.edit_count = Number(r.edit_count || 0);
    o.items = byId[o.lead_id];
    return o;
  });
}

/** Earlier visits for a customer code (any staff), newest first. */
function lookup_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return [];
  var leads = readTable_('Leads').filter(function (r) {
    return String(r.customer_code).trim().toUpperCase() === code || String(r.original_walkin_code).trim().toUpperCase() === code;
  });
  if (!leads.length) return [];
  var ids = {};
  leads.forEach(function (r) { ids[String(r.lead_id)] = []; });
  readTable_('LeadItems').forEach(function (it) {
    var l = ids[String(it.lead_id)];
    if (l) l.push(String(it.product_name || it.product_code));
  });
  leads.sort(function (a, b) { return (toDate_(b.created_at) || 0) - (toDate_(a.created_at) || 0); });
  return leads.slice(0, 5).map(function (r) {
    return {
      visitor_name: String(r.visitor_name || ''),
      visitor_brand: String(r.visitor_brand || ''),
      visitor_phone: String(r.visitor_phone || ''),
      staff_name: String(r.staff_name || ''),
      created_at: isoOrEmpty_(r.created_at),
      lead_temp: String(r.lead_temp || ''),
      notes: String(r.notes || '').slice(0, 300),
      products: ids[String(r.lead_id)]
    };
  });
}

/** Highest walk-in sequence number this staff has used, so a new phone does not reuse codes. */
function maxWalkinSeq_(staffId) {
  var prefix = walkinPrefix_(staffId);
  var max = 0;
  readTable_('Leads').forEach(function (r) {
    [r.customer_code, r.original_walkin_code].forEach(function (c) {
      c = String(c || '').trim().toUpperCase();
      if (c.indexOf(prefix) === 0) {
        var n = Number(c.slice(prefix.length));
        if (n > max) max = n;
      }
    });
  });
  return max;
}

function walkinPrefix_(staffId) {
  var digits = String(staffId).replace(/\D/g, '');
  return 'W' + (digits || String(staffId).toUpperCase()) + '-';
}

/* --------------------------------------------------------------- helpers */

function cleanLead_(l) {
  var o = {};
  LEAD_FIELDS.forEach(function (f) { o[f] = str_(l[f], f === 'notes' ? 5000 : 200); });
  o.customer_code = o.customer_code.toUpperCase();
  o.original_walkin_code = o.original_walkin_code.toUpperCase();
  o.code_type = o.code_type === 'WALKIN' ? 'WALKIN' : 'REGISTERED';
  o.samples_given = isTrue_(l.samples_given);   // stored as a real TRUE/FALSE cell
  return o;
}

function cleanItem_(it) {
  return {
    product_code: str_(it.product_code, 100),
    product_name: str_(it.product_name, 200),
    product_SKU: str_(it.product_SKU, 100),
    main_category: str_(it.main_category, 100),
    category: str_(it.category, 100),
    interest_level: str_(it.interest_level, 20)
  };
}

function itemsSummary_(items) {
  return items.map(function (i) { return i.product_code + ' ' + i.interest_level; }).sort().join('; ');
}

function writeItems_(sh, hdr, leadId, code, staffId, updatedAt, items) {
  if (!items.length) return;
  var rows = items.map(function (i) {
    var o = {
      lead_id: leadId, customer_code: code, product_code: i.product_code, product_name: i.product_name,
      product_SKU: i.product_SKU, main_category: i.main_category, category: i.category,
      interest_level: i.interest_level, staff_id: staffId, updated_at: updatedAt
    };
    return objToRow_(hdr, o);
  });
  var start = sh.getLastRow() + 1;
  ensureRows_(sh, start + rows.length - 1);
  sh.getRange(start, 1, rows.length, hdr.length).setValues(rows);
}

function ensureRows_(sh, lastNeeded) {
  var max = sh.getMaxRows();
  if (lastNeeded > max) sh.insertRowsAfter(max, Math.max(500, lastNeeded - max));
}

function readItems_(sh, hdr, leadId) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var idCol = hdr.indexOf('lead_id');
  return sh.getRange(2, 1, last - 1, hdr.length).getValues()
    .filter(function (r) { return String(r[idCol]) === leadId; })
    .map(function (r) { return cleanItem_(rowToObj_(hdr, r)); });
}

function deleteItems_(sh, hdr, leadId) {
  var last = sh.getLastRow();
  if (last < 2) return;
  var idCol = hdr.indexOf('lead_id') + 1;
  var ids = sh.getRange(2, idCol, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]) === leadId) sh.deleteRow(i + 2);
  }
}

function findRow_(sh, hdr, colName, value) {
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var col = hdr.indexOf(colName) + 1;
  var vals = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === value) return i + 2;
  return 0;
}

function readTable_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name + ' (run setup)');
  var last = sh.getLastRow();
  var hdr = headers_(sh);
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, hdr.length).getValues().map(function (r) { return rowToObj_(hdr, r); });
}

function headers_(sh) {
  var lastCol = sh.getLastColumn();
  if (!lastCol) throw new Error('Tab has no headers: ' + sh.getName() + ' (run setup)');
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
}

function rowToObj_(hdr, row) {
  var o = {};
  hdr.forEach(function (h, i) { if (h) o[h] = row[i]; });
  return o;
}

function objToRow_(hdr, obj, base) {
  return hdr.map(function (h, i) {
    if (h && Object.prototype.hasOwnProperty.call(obj, h)) return obj[h];
    return base ? base[i] : '';
  });
}

function appendObj_(sh, hdr, obj) {
  var row = sh.getLastRow() + 1;
  ensureRows_(sh, row);
  sh.getRange(row, 1, 1, hdr.length).setValues([objToRow_(hdr, obj)]);
}

function str_(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 200);
}

function isTrue_(v) {
  return v === true || /^(true|yes|y|1)$/i.test(String(v).trim());
}

function toDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function isoOrEmpty_(v) {
  var d = toDate_(v);
  return d ? d.toISOString() : '';
}
