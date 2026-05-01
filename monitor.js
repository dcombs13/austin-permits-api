#!/usr/bin/env node
// Autonomous permit monitor — runs hourly, finds new Austin permits, sends outreach emails.
// Run: node monitor.js
// Env vars required: HUNTER_API_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY

require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const { fetchEnrichedPermits } = require('./enrich');
const { findContractorEmail } = require('./find-email');
const { writeOutreachEmail } = require('./write-email');
const { sendOutreachEmail } = require('./send-email');

const DB_PATH = path.join(__dirname, 'permits.db');
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Permit types to watch — BP=residential building, BC=commercial building
// New permits don't have valuations yet (Austin fills those in during plan review)
// so we filter by type, not dollar amount
const PERMIT_TYPES = (process.env.MONITOR_PERMIT_TYPES ?? 'BP,BC').split(',').map((s) => s.trim());

// How far back to look on first ever run (gives immediate results when you start the monitor)
const INITIAL_LOOKBACK_HOURS = Number(process.env.MONITOR_LOOKBACK_HOURS ?? 48);

// Max permits to process per check (Hunter quota protection)
const BATCH_LIMIT = 25;

// ------------------------------------------------------------------
// State + logging (same permits.db used by the API)
// ------------------------------------------------------------------

function getDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitor_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS outreach_log (
      permit_number TEXT PRIMARY KEY,
      checked_at    TEXT,
      address       TEXT,
      to_email      TEXT,
      subject       TEXT,
      resend_id     TEXT,
      status        TEXT,
      reason        TEXT
    );
  `);
  return db;
}

function getLastChecked(db) {
  const row = db.prepare('SELECT value FROM monitor_state WHERE key = ?').get('last_checked_at');
  return row?.value ?? null;
}

function setLastChecked(db, iso) {
  db.prepare('INSERT OR REPLACE INTO monitor_state (key, value) VALUES (?, ?)').run('last_checked_at', iso);
}

function alreadyProcessed(db, permitNumber) {
  return !!db.prepare('SELECT 1 FROM outreach_log WHERE permit_number = ?').get(permitNumber);
}

function logResult(db, { permitNumber, checkedAt, address, toEmail, subject, resendId, status, reason }) {
  db.prepare(`
    INSERT OR IGNORE INTO outreach_log
      (permit_number, checked_at, address, to_email, subject, resend_id, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(permitNumber, checkedAt, address ?? null, toEmail ?? null, subject ?? null, resendId ?? null, status, reason ?? null);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ------------------------------------------------------------------
// One check cycle
// ------------------------------------------------------------------

async function runCheck(dryRun = false) {
  const db = getDb();
  const now = new Date();

  // On first run, look back INITIAL_LOOKBACK_HOURS so there's something to process immediately
  let lastChecked = getLastChecked(db);
  if (!lastChecked) {
    const lookback = new Date(now.getTime() - INITIAL_LOOKBACK_HOURS * 60 * 60 * 1000);
    lastChecked = lookback.toISOString();
    log(`First run — looking back ${INITIAL_LOOKBACK_HOURS}h to ${lastChecked}`);
  }

  // Stamp now before fetching so any permit issued during this run gets caught next time
  setLastChecked(db, now.toISOString());

  log(`Checking permits since ${lastChecked}  (types: ${PERMIT_TYPES.join(', ')})`);

  let permits;
  try {
    permits = await fetchEnrichedPermits({
      since: lastChecked,
      permitType: PERMIT_TYPES,
      limit: BATCH_LIMIT,
      findEmail: false, // we handle email lookup per-permit below for better error isolation
    });
  } catch (err) {
    log(`ERROR fetching permits: ${err.message}`);
    db.close();
    return;
  }

  log(`Found ${permits.length} new permit(s)`);
  if (permits.length === 0) { db.close(); return; }

  let sent = 0, skipped = 0, errors = 0;
  let hunterExhausted = false;

  for (const permit of permits) {
    const checkedAt = new Date().toISOString();

    if (alreadyProcessed(db, permit.permit_number)) {
      log(`  skip ${permit.permit_number} — already processed`);
      continue;
    }

    // --- Step 1: find email ---
    let emailResult = null;
    if (!hunterExhausted) {
      const company = permit.contractor?.company_name;
      const name = permit.contractor?.full_name;

      if (company || name) {
        try {
          emailResult = await findContractorEmail(company, name);
        } catch (e) {
          if (e.response?.status === 429 || e.message.includes('HUNTER_API_KEY')) {
            if (e.message.includes('HUNTER_API_KEY')) {
              log('  HUNTER_API_KEY not set — skipping all email lookups');
            } else {
              log('  Hunter.io quota exhausted — skipping remaining email lookups this run');
            }
            hunterExhausted = true;
          } else {
            log(`  Hunter error for ${permit.permit_number}: ${e.message}`);
          }
        }
      }
    }

    if (!emailResult?.email) {
      logResult(db, {
        permitNumber: permit.permit_number,
        checkedAt,
        address: permit.address,
        status: 'skipped',
        reason: hunterExhausted ? 'hunter quota exhausted' : 'no email found',
      });
      skipped++;
      continue;
    }

    // --- Step 2: write email ---
    const enrichedPermit = {
      ...permit,
      contractor: { ...permit.contractor, email: emailResult.email },
    };

    let drafted;
    try {
      drafted = await writeOutreachEmail(enrichedPermit);
    } catch (e) {
      log(`  Claude error for ${permit.permit_number}: ${e.message}`);
      logResult(db, { permitNumber: permit.permit_number, checkedAt, address: permit.address, status: 'error', reason: `claude: ${e.message}` });
      errors++;
      continue;
    }

    // --- Step 3: send (or dry-run) ---
    if (dryRun) {
      log(`  [DRY RUN] Would send to ${drafted.to_email} — "${drafted.subject}"`);
      logResult(db, {
        permitNumber: permit.permit_number,
        checkedAt,
        address: permit.address,
        toEmail: drafted.to_email,
        subject: drafted.subject,
        status: 'dry_run',
      });
      sent++;
      continue;
    }

    try {
      const sendResult = await sendOutreachEmail(drafted);
      log(`  ✓ Sent to ${drafted.to_email}  (${permit.address})  id=${sendResult.id}`);
      logResult(db, {
        permitNumber: permit.permit_number,
        checkedAt,
        address: permit.address,
        toEmail: drafted.to_email,
        subject: drafted.subject,
        resendId: sendResult.id,
        status: 'sent',
      });
      sent++;
    } catch (e) {
      log(`  ✗ Resend error for ${permit.permit_number}: ${e.message}`);
      logResult(db, { permitNumber: permit.permit_number, checkedAt, address: permit.address, status: 'error', reason: `resend: ${e.message}` });
      errors++;
    }
  }

  db.close();
  log(`Done — ${sent} ${dryRun ? 'would send' : 'sent'}, ${skipped} skipped (no email), ${errors} errors\n`);
}

module.exports = { runCheck };

// Only start the poll loop when run directly (node monitor.js)
if (require.main === module) {
  const DRY_RUN = process.argv.includes('--dry-run');
  if (DRY_RUN) log('Running in DRY RUN mode — emails will not be sent');

  async function loop() {
    try {
      await runCheck(DRY_RUN);
    } catch (err) {
      log(`Unhandled error in runCheck: ${err.message}`);
    }
    setTimeout(loop, POLL_INTERVAL_MS);
  }

  loop();
}
