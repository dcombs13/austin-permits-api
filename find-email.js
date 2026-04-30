const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const { normalizeName } = require('./db');

const HUNTER_BASE = 'https://api.hunter.io/v2';
const DB_PATH = path.join(__dirname, 'permits.db');

function getDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_cache (
      company_name_norm TEXT PRIMARY KEY,
      domain            TEXT,
      email             TEXT,
      confidence        INTEGER,
      pattern           TEXT,
      cached_at         TEXT
    )
  `);
  return db;
}

function parseName(fullName) {
  if (!fullName) return { first: null, last: null };
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts[parts.length - 1] };
}

async function domainSearch(companyName, apiKey) {
  const { data } = await axios.get(`${HUNTER_BASE}/domain-search`, {
    params: { company: companyName, api_key: apiKey, limit: 10 },
  });
  return data.data;
}

async function emailFinder(domain, firstName, lastName, apiKey) {
  const { data } = await axios.get(`${HUNTER_BASE}/email-finder`, {
    params: { domain, first_name: firstName, last_name: lastName, api_key: apiKey },
  });
  return data.data;
}

// Returns { email, domain, confidence, pattern, from_cache } or null.
// Each uncached company costs 1–2 Hunter credits:
//   1 credit  → domain-search (gets domain + any publicly-indexed emails)
//   +1 credit → email-finder (only called if domain found but no high-confidence email yet)
async function findContractorEmail(companyName, fullName) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new Error('HUNTER_API_KEY is not set');

  const norm = normalizeName(companyName || fullName || '');
  if (!norm) return null;

  const db = getDb();

  const cached = db.prepare('SELECT * FROM email_cache WHERE company_name_norm = ?').get(norm);
  if (cached) {
    db.close();
    return cached.email
      ? { email: cached.email, domain: cached.domain, confidence: cached.confidence, pattern: cached.pattern, from_cache: true }
      : null;
  }

  let domain = null, email = null, confidence = null, pattern = null;

  try {
    const result = await domainSearch(companyName || fullName, apiKey);
    domain = result?.domain ?? null;
    pattern = result?.pattern ?? null;

    const emails = (result?.emails ?? []).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    if (emails.length > 0) {
      email = emails[0].value;
      confidence = emails[0].confidence;
    }

    // If we found the domain but no email yet (or low confidence), try email-finder
    if (domain && fullName && (confidence ?? 0) < 70) {
      const { first, last } = parseName(fullName);
      if (first && last) {
        try {
          const found = await emailFinder(domain, first, last, apiKey);
          if (found?.email && (found.confidence ?? 0) > (confidence ?? 0)) {
            email = found.email;
            confidence = found.confidence;
          }
        } catch (e) {
          if (e.response?.status !== 404) throw e;
        }
      }
    }
  } catch (err) {
    db.close();
    // 404 = genuinely not found; cache null so we don't retry and waste credits
    if (err.response?.status === 404) {
      const db2 = getDb();
      db2.prepare(`INSERT OR IGNORE INTO email_cache (company_name_norm, cached_at) VALUES (?, ?)`).run(norm, new Date().toISOString());
      db2.close();
      return null;
    }
    throw err;
  }

  db.prepare(`
    INSERT OR REPLACE INTO email_cache (company_name_norm, domain, email, confidence, pattern, cached_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(norm, domain, email ?? null, confidence ?? null, pattern ?? null, new Date().toISOString());
  db.close();

  return email ? { email, domain, confidence, pattern, from_cache: false } : null;
}

async function quotaStatus() {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) throw new Error('HUNTER_API_KEY is not set');
  const { data } = await axios.get(`${HUNTER_BASE}/account`, { params: { api_key: apiKey } });
  const { searches_left, requests_left } = data.data || {};
  return { searches_left, requests_left };
}

module.exports = { findContractorEmail, quotaStatus };
