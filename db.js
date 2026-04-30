const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'permits.db');

let _db = null;
function getDb() {
  if (!_db) _db = new Database(DB_PATH);
  return _db;
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\b(llc|inc|corp|co|ltd|lp|pllc|dba|and|the)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tdlr_licenses
    WHERE business_phone = ? OR individual_phone = ?
    ORDER BY expiration_date DESC LIMIT 1
  `).get(normalized, normalized);
}

function lookupByName(name) {
  if (!name) return null;
  const norm = normalizeName(name);
  if (!norm) return null;
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tdlr_licenses
    WHERE business_name_norm LIKE ? OR individual_name_norm LIKE ?
    ORDER BY expiration_date DESC LIMIT 1
  `).get(`%${norm}%`, `%${norm}%`);
}

function lookupContractor(permit) {
  // Try phone match first (most reliable)
  const phone = permit.contractor_phone;
  if (phone) {
    const match = lookupByPhone(phone);
    if (match) return match;
  }
  // Fall back to company name
  if (permit.contractor_company_name) {
    const match = lookupByName(permit.contractor_company_name);
    if (match) return match;
  }
  // Fall back to individual name
  if (permit.contractor_full_name) {
    const match = lookupByName(permit.contractor_full_name);
    if (match) return match;
  }
  return null;
}

function isReady() {
  try {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM tdlr_licenses').get();
    return row.count > 0;
  } catch {
    return false;
  }
}

module.exports = { lookupContractor, lookupByPhone, lookupByName, normalizePhone, normalizeName, isReady };
