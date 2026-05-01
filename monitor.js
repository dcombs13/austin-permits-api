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
// Only permits requiring significant structural wood (framing lumber,
// plywood, OSB, engineered wood, decking) qualify for outreach.
// ------------------------------------------------------------------

// HIGH VALUE (+15) — always send, structural wood definitely needed
const HIGH_VALUE_SIGNALS = [
  { re: /\bnew\s+(single.famil|sfr|residence|residential|house|home|dwelling)\b/i, label: 'new SFR' },
  { re: /\b(single.famil|sfr)\b/i,                                                  label: 'SFR' },
  { re: /\bnew\s+(multi.famil|apartment|condo|duplex|triplex|fourplex)\b/i,          label: 'new multifamily' },
  { re: /\bnew\s+(commercial|warehouse|retail|office|industrial|building)\b/i,       label: 'new commercial' },
  { re: /\broom\s+addition\b|\bhome\s+addition\b|\bhouse\s+addition\b/i,             label: 'home addition' },
  { re: /\baddition\b/i,                                                              label: 'addition' },
  { re: /\badu\b|\baccessory\s+dwelling\b/i,                                          label: 'ADU' },
  { re: /\bnew\s+garage\b|\bgarage\s+(construction|build|addition)\b/i,               label: 'garage construction' },
  { re: /\bgarage\s+(conversion|converted)\s+to\s+(living|habitable)\b/i,             label: 'garage conversion' },
  { re: /\bsecond\s+stor(y|ies)\b|\b2nd\s+stor(y|ies)\b/i,                           label: 'second story addition' },
];

// MEDIUM VALUE (+8) — send only if valuation > $50k or valuation unknown
const MEDIUM_VALUE_SIGNALS = [
  { re: /\bstructural\s+(renovation|remodel|framing|modification)\b/i,                label: 'structural renovation' },
  { re: /\bgut\s+(rehab|remodel|renovation)\b|\bfull\s+(gut|remodel)\b/i,             label: 'gut rehab' },
  { re: /\b(barn|agricultural|farm)\b.*\b(building|structure|construction)\b/i,        label: 'barn/agricultural' },
  { re: /\b(building|structure|construction)\b.*\b(barn|agricultural|farm)\b/i,        label: 'barn/agricultural' },
];

// HARD EXCLUDES — score -25, never send
const HARD_EXCLUDES = [
  { re: /\btenant\s+improvement\b|\bfinish\s+out\b|\binterior\s+finish\b/i,           label: 'TI / finish out' },
  { re: /\binterior\s+(demo(lition)?|remodel|renovation)\b/i,                          label: 'interior only' },
  { re: /\bkitchen\s+(remodel|renovation|update|upgrade|demo)\b/i,                     label: 'kitchen remodel' },
  { re: /\bbath(room)?\s+(remodel|renovation|update|upgrade|demo)\b/i,                 label: 'bathroom remodel' },
  { re: /\belectric(al)?\b/i,                                                           label: 'electrical' },
  { re: /\bplumb(ing)?\b/i,                                                             label: 'plumbing' },
  { re: /\bhvac\b|\bmechanical\b/i,                                                     label: 'HVAC/mechanical' },
  { re: /\bre-?roof(ing)?\b|\broof(ing)?\b/i,                                           label: 'roofing' },
  { re: /\bpool\b|\bspa\b/i,                                                             label: 'pool/spa' },
  { re: /\bfence\b/i,                                                                    label: 'fence' },
  { re: /\bsign(age)?\b/i,                                                               label: 'signage' },
  { re: /\bfire\s+(alarm|sprinkler|suppression)\b/i,                                    label: 'fire alarm/sprinkler' },
  { re: /\bfoundation\s+repair\b/i,                                                      label: 'foundation repair only' },
  { re: /\bpaint(ing)?\b/i,                                                              label: 'painting' },
  { re: /\bflooring\b/i,                                                                 label: 'flooring' },
];

const MIN_RELEVANCE_SCORE = Number(process.env.MIN_RELEVANCE_SCORE ?? 8);

function scorePermitRelevance(permit) {
  const text = [permit.description, permit.permit_type, permit.work_class].filter(Boolean).join(' ');
  const workClass = (permit.work_class || '').toLowerCase().trim();
  const valuation = permit.job_valuation || 0;

  // Hard valuation floor — skip if we know the job is too small
  if (valuation > 0 && valuation < 25_000) {
    return { score: -25, reason: `under $25k valuation ($${valuation.toLocaleString()})` };
  }

  // Hard excludes — checked before any positive signals
  for (const { re, label } of HARD_EXCLUDES) {
    if (re.test(text)) return { score: -25, reason: `excluded: ${label}` };
  }

  // work_class='new' or 'addition' on a BP/BC permit is unambiguously high value
  if (workClass === 'new')      return { score: 15, reason: 'new construction (work_class=new)' };
  if (workClass === 'addition') return { score: 15, reason: 'addition (work_class=addition)' };

  // High value keyword scan
  const hvHits = HIGH_VALUE_SIGNALS.filter(({ re }) => re.test(text)).map(({ label }) => label);
  if (hvHits.length > 0) return { score: 15, reason: `high value: ${hvHits.join(', ')}` };

  // Medium value keyword scan
  const mvHits = MEDIUM_VALUE_SIGNALS.filter(({ re }) => re.test(text)).map(({ label }) => label);
  if (mvHits.length > 0) {
    if (valuation > 0 && valuation < 50_000) {
      return { score: 0, reason: `medium value (${mvHits.join(', ')}) but under $50k ($${valuation.toLocaleString()})` };
    }
    return { score: 8, reason: `medium value: ${mvHits.join(', ')}${valuation > 0 ? ` ($${valuation.toLocaleString()})` : ''}` };
  }

  return { score: 0, reason: 'no structural wood signals found' };
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
