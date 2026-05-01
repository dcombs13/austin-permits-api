#!/usr/bin/env node
// Autonomous permit monitor — runs hourly, finds new Austin permits, sends outreach emails.
// Run: node monitor.js
// Env vars required: HUNTER_API_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY, SENDER_NAME, SENDER_EMAIL, SENDER_COMPANY
// TEST_MODE=true redirects all emails to TEST_EMAIL instead of real contractors

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

const TEST_MODE = process.env.TEST_MODE === 'true';
const TEST_EMAIL = process.env.TEST_EMAIL || 'dpcombs2003@gmail.com';

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

function alreadySent(db, permitNumber) {
  return !!db.prepare("SELECT 1 FROM outreach_log WHERE permit_number = ? AND status = 'sent'").get(permitNumber);
}

function logResult(db, { permitNumber, checkedAt, address, toEmail, subject, resendId, status, reason }) {
  // INSERT OR REPLACE so a 'sent' entry always overwrites a prior 'skipped'/'error' row,
  // ensuring alreadySent() reliably finds it on future runs.
  db.prepare(`
    INSERT OR REPLACE INTO outreach_log
      (permit_number, checked_at, address, to_email, subject, resend_id, status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(permitNumber, checkedAt, address ?? null, toEmail ?? null, subject ?? null, resendId ?? null, status, reason ?? null);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ------------------------------------------------------------------
// Permit relevance scoring — lumber yard filter
// ------------------------------------------------------------------

const INCLUDE_SIGNALS = [
  { re: /\bnew\s+(construction|build|home|house|dwelling|sfr|residence|commercial|office|building|structure)\b/i, label: 'new construction', score: 10 },
  { re: /\baddition\b/i,                        label: 'addition',           score: 8 },
  { re: /\bframing?\b/i,                        label: 'framing',            score: 8 },
  { re: /\bstructural\b/i,                      label: 'structural',         score: 7 },
  { re: /\badu\b|\baccessory\s+dwelling\b/i,    label: 'ADU',                score: 7 },
  { re: /\b(gut\s+)?remodel\b/i,                label: 'remodel',            score: 5 },
  { re: /\brenovation\b/i,                      label: 'renovation',         score: 5 },
  { re: /\bshell\b/i,                           label: 'shell',              score: 5 },
  { re: /\bdeck\b/i,                            label: 'deck',               score: 4 },
  { re: /\bporch\b/i,                           label: 'porch',              score: 4 },
  { re: /\bgarage\b/i,                          label: 'garage',             score: 4 },
  { re: /\btenant\s+improvement\b|\bT\.?I\.?\b/i, label: 'tenant improvement', score: 4 },
];

const EXCLUDE_SIGNALS = [
  { re: /\belectric(al)?\b/i,                           label: 'electrical',       score: -8 },
  { re: /\bplumb(ing)?\b/i,                             label: 'plumbing',         score: -8 },
  { re: /\bhvac\b|\bmechanical\b/i,                     label: 'hvac/mechanical',  score: -8 },
  { re: /\bpool\b|\bspa\b/i,                            label: 'pool/spa',         score: -8 },
  { re: /\bre-?roof(ing)?\b|\broof(ing)?\b/i,            label: 'roofing',          score: -20 },
  { re: /\bsolar\b/i,                                   label: 'solar',            score: -7 },
  { re: /\bfire\s+(sprinkler|suppression|alarm)\b/i,    label: 'fire suppression', score: -7 },
  { re: /\bsign(age)?\b/i,                              label: 'signage',          score: -8 },
  { re: /\bfence\b/i,                                   label: 'fence',            score: -5 },
  { re: /\bwindow\s+replacement\b/i,                    label: 'window replacement', score: -4 },
  { re: /\bpaint(ing)?\b/i,                             label: 'painting',         score: -4 },
];

const WORK_CLASS_SCORES = {
  'new': 10, 'addition': 8, 'renovation': 5, 'remodel': 5, 'alteration': 4, 'repair': 1, 'demolition': -2,
};

// Minimum score to qualify for outreach — below this the permit is skipped
const MIN_RELEVANCE_SCORE = Number(process.env.MIN_RELEVANCE_SCORE ?? 4);

function scorePermitRelevance(permit) {
  const text = [permit.description, permit.permit_type, permit.work_class].filter(Boolean).join(' ');
  const workClass = (permit.work_class || '').toLowerCase().trim();

  let score = WORK_CLASS_SCORES[workClass] ?? 0;
  const hits = workClass && WORK_CLASS_SCORES[workClass] != null
    ? [`work_class=${workClass}(${WORK_CLASS_SCORES[workClass] >= 0 ? '+' : ''}${WORK_CLASS_SCORES[workClass]})`]
    : [];

  for (const { re, label, score: s } of INCLUDE_SIGNALS) {
    if (re.test(text)) { score += s; hits.push(`+${s} ${label}`); }
  }
  for (const { re, label, score: s } of EXCLUDE_SIGNALS) {
    if (re.test(text)) { score += s; hits.push(`${s} ${label}`); }
  }

  return { score, reason: hits.join(', ') || 'no signals matched' };
}

// ------------------------------------------------------------------
// One check cycle
// ------------------------------------------------------------------

async function runCheck(dryRun = false, lookbackHours = null) {
  const db = getDb();
  const now = new Date();

  let lastChecked;
  if (lookbackHours !== null) {
    lastChecked = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000).toISOString();
    log(`--lookback-hours override — looking back ${lookbackHours}h to ${lastChecked}`);
  } else {
    lastChecked = getLastChecked(db);
    if (!lastChecked) {
      lastChecked = new Date(now.getTime() - INITIAL_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
      log(`First run — looking back ${INITIAL_LOOKBACK_HOURS}h to ${lastChecked}`);
    }
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

    // Hard dedup — never resend regardless of lookback or DB state
    if (alreadySent(db, permit.permit_number)) {
      log(`  skip ${permit.permit_number} — already sent (dedup)`);
      continue;
    }

    if (alreadyProcessed(db, permit.permit_number)) {
      log(`  skip ${permit.permit_number} — already processed`);
      continue;
    }

    // --- Relevance filter ---
    const { score, reason } = scorePermitRelevance(permit);
    if (score < MIN_RELEVANCE_SCORE) {
      log(`  skip ${permit.permit_number} — relevance ${score} (${reason})`);
      logResult(db, { permitNumber: permit.permit_number, checkedAt, address: permit.address, status: 'skipped', reason: `low relevance: ${score} — ${reason}` });
      skipped++;
      continue;
    }
    log(`  ${permit.permit_number} relevance ${score} (${reason})`);

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
      const recipient = TEST_MODE ? TEST_EMAIL : drafted.to_email;
      const sendResult = await sendOutreachEmail({
        ...drafted,
        to_name: TEST_MODE ? null : drafted.to_name,
        to_email: recipient,
        sender_name: process.env.SENDER_NAME,
        sender_email: process.env.SENDER_EMAIL,
        sender_company: process.env.SENDER_COMPANY,
      });
      log(`  ✓ ${TEST_MODE ? `[TEST → ${recipient}]` : ''} Sent to ${drafted.to_email}  (${permit.address})  id=${sendResult.id}`);
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
  if (TEST_MODE) log(`Running in TEST MODE — all emails redirected to ${TEST_EMAIL}`);

  const lookbackArg = process.argv.find((a) => a.startsWith('--lookback-hours='));
  const LOOKBACK_OVERRIDE = lookbackArg ? Number(lookbackArg.split('=')[1]) : null;

  async function loop(firstRun = false) {
    try {
      await runCheck(DRY_RUN, firstRun ? LOOKBACK_OVERRIDE : null);
    } catch (err) {
      log(`Unhandled error in runCheck: ${err.message}`);
    }
    setTimeout(() => loop(false), POLL_INTERVAL_MS);
  }

  loop(true);
}
