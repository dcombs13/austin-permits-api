#!/usr/bin/env node
// Downloads Texas contractor license database from TDLR and loads into SQLite.
// Run once: node download-tdlr.js
// Re-run weekly to refresh data.

const https = require('https');
const readline = require('readline');
const Database = require('better-sqlite3');
const path = require('path');
const { normalizePhone, normalizeName } = require('./db');

const TDLR_URL = 'https://tdlr.texas.gov/dbproduction2/ltlicfile.csv';
const DB_PATH = path.join(__dirname, 'permits.db');

// Actual license types in TDLR relevant to construction trades.
// Note: General contractors and plumbers are NOT in TDLR (different state boards).
const RELEVANT_TYPES = new Set([
  'a/c contractor',
  'a/c technician',
  'electrical contractor',
  'master electrician',
  'journeyman electrician',
  'apprentice electrician',
  'residential wireman',
  'journeyman industrial electrician',
  'journeyman lineman electrician',
  'maintenance electrician',
  'electrical sign contractor',
  'master sign electrician',
  'journeyman sign electrician',
  'appliance installer',
  'appliance installation contractor',
  'elevator contractor',
  'elevator responsible party',
  'water well driller/pump installer',
]);

function isRelevant(licenseType) {
  return RELEVANT_TYPES.has(licenseType.toLowerCase().trim());
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tdlr_licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      license_type TEXT,
      license_number TEXT,
      license_subtype TEXT,
      expiration_date TEXT,
      county TEXT,
      individual_name TEXT,
      individual_phone TEXT,
      business_name TEXT,
      business_phone TEXT,
      business_zip TEXT,
      business_name_norm TEXT,
      individual_name_norm TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_biz_phone ON tdlr_licenses(business_phone);
    CREATE INDEX IF NOT EXISTS idx_ind_phone ON tdlr_licenses(individual_phone);
    CREATE INDEX IF NOT EXISTS idx_biz_name ON tdlr_licenses(business_name_norm);
    CREATE INDEX IF NOT EXISTS idx_ind_name ON tdlr_licenses(individual_name_norm);
  `);
}

function download() {
  return new Promise((resolve, reject) => {
    console.log('Downloading TDLR license database...');
    const db = new Database(DB_PATH);
    initDb(db);

    db.exec('DELETE FROM tdlr_licenses');

    const insert = db.prepare(`
      INSERT INTO tdlr_licenses
        (license_type, license_number, license_subtype, expiration_date, county,
         individual_name, individual_phone, business_name, business_phone, business_zip,
         business_name_norm, individual_name_norm)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const batchInsert = db.transaction((rows) => {
      for (const r of rows) insert.run(r);
    });

    let headers = null;
    let total = 0;
    let imported = 0;
    let batch = [];

    // Fault-tolerant CSV line parser — handles TDLR's malformed quotes
    function parseCSVLine(line) {
      const fields = [];
      let field = '';
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuote && line[i + 1] === '"') { field += '"'; i++; }
          else inQuote = !inQuote;
        } else if (ch === ',' && !inQuote) {
          fields.push(field.trim());
          field = '';
        } else {
          field += ch;
        }
      }
      fields.push(field.trim());
      return fields;
    }

    const req = https.get(TDLR_URL, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from TDLR`));
        return;
      }
      console.log(`  Content-Length: ${res.headers['content-length'] ? Math.round(res.headers['content-length'] / 1024 / 1024) + 'MB' : 'unknown'}`);

      const rl = readline.createInterface({ input: res, crlfDelay: Infinity });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        const fields = parseCSVLine(line);
        if (!headers) { headers = fields; return; }
        if (fields.length < headers.length) return;

        const row = {};
        headers.forEach((h, i) => { row[h] = fields[i] || ''; });

        total++;
        const licenseType = row['LICENSE TYPE'] || '';
        if (!isRelevant(licenseType)) return;

        const bizPhone = normalizePhone(row['BUSINESS PHONE']);
        const indPhone = normalizePhone(row['PHONE NUMBER']);
        const bizName = row['BUSINESS NAME'] || '';
        const indName = row['NAME'] || '';

        batch.push([
          licenseType,
          row['LICENSE NUMBER'] || '',
          row['LICENSE SUBTYPE'] || '',
          row['LICENSE EXPIRATION DATE'] || '',
          row['COUNTY'] || '',
          indName,
          indPhone,
          bizName,
          bizPhone,
          row['BUSINESS ZIP'] || '',
          normalizeName(bizName),
          normalizeName(indName),
        ]);

        imported++;
        if (batch.length >= 500) {
          batchInsert(batch);
          batch = [];
          process.stdout.write(`\r  Processed ${total.toLocaleString()} records, imported ${imported.toLocaleString()} contractors`);
        }
      });

      rl.on('close', () => {
        if (batch.length > 0) batchInsert(batch);
        process.stdout.write(`\r  Processed ${total.toLocaleString()} records, imported ${imported.toLocaleString()} contractors\n`);
        console.log('Done. Database saved to', DB_PATH);
        db.close();
        resolve({ total, imported });
      });
    });

    req.on('error', reject);
  });
}

download()
  .then(({ total, imported }) => {
    console.log(`\nSummary: ${imported.toLocaleString()} construction contractors imported from ${total.toLocaleString()} total records`);
  })
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
