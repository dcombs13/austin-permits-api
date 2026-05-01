require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { fetchEnrichedPermits } = require('./enrich');
const { isReady } = require('./db');
const { findContractorEmail, quotaStatus } = require('./find-email');
const { writeOutreachEmail } = require('./write-email');
const { sendOutreachEmail } = require('./send-email');

const { runCheck } = require('./monitor');

const app = express();
const PORT = process.env.PORT || 3000;

const AUSTIN_API = 'https://data.austintexas.gov/resource/3syk-w9eu.json';

app.use(express.json());
app.use(express.static('.'));

app.get('/permits/recent', async (req, res) => {
  try {
    const { zip, limit = 10, api_key } = req.query;
    if (!api_key) return res.status(401).json({ error: 'API key required. Sign up at permitiq.com' });
    let url = `${AUSTIN_API}?$limit=${limit}&$order=issue_date DESC`;
    if (zip) url += `&original_zip=${zip}`;
    const { data } = await axios.get(url);
    res.json({ results: data, count: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/permits/high-value', async (req, res) => {
  try {
    const { min = 500000, limit = 10, api_key } = req.query;
    if (!api_key) return res.status(401).json({ error: 'API key required. Sign up at permitiq.com' });
    const url = `${AUSTIN_API}?$where=total_job_valuation > '${min}'&$limit=${limit}&$order=total_job_valuation DESC`;
    const { data } = await axios.get(url);
    res.json({ results: data, count: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single contractor email lookup — checks cache first, costs 1–2 Hunter credits if uncached
app.get('/contractor/find-email', async (req, res) => {
  try {
    const { company, name, api_key } = req.query;
    if (!api_key) return res.status(401).json({ error: 'API key required.' });
    if (!company && !name) return res.status(400).json({ error: 'Provide company and/or name.' });
    const result = await findContractorEmail(company, name);
    res.json({ result: result ?? { email: null, note: 'Not found in Hunter.io' } });
  } catch (err) {
    const status = err.response?.status === 429 ? 429 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Hunter.io remaining quota
app.get('/hunter/quota', async (req, res) => {
  try {
    const { api_key } = req.query;
    if (!api_key) return res.status(401).json({ error: 'API key required.' });
    res.json(await quotaStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/permits/enriched', async (req, res) => {
  try {
    const { zip, min_value, limit = 20, permit_type, find_email, api_key } = req.query;
    if (!api_key) return res.status(401).json({ error: 'API key required.' });
    const permits = await fetchEnrichedPermits({
      zip,
      minValue: min_value,
      limit: Math.min(Number(limit), 100),
      permitType: permit_type,
      findEmail: find_email === 'true',
    });
    res.json({
      results: permits,
      count: permits.length,
      tdlr_db_loaded: isReady(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Draft outreach email for a single enriched permit
app.post('/permits/write-email', async (req, res) => {
  try {
    const { api_key } = req.query;
    if (!api_key) return res.status(401).json({ error: 'API key required.' });
    const permit = req.body;
    if (!permit || !permit.address) return res.status(400).json({ error: 'POST a permit object in the request body.' });
    const email = await writeOutreachEmail(permit);
    res.json(email);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full pipeline: fetch permits → find email → write email → send via Resend
// Query params: zip, min_value, limit (default 5, max 20), permit_type, dry_run=true to skip sending
app.post('/permits/send-outreach', async (req, res) => {
  try {
    const { zip, min_value, limit = 5, permit_type, dry_run, api_key } = req.query;
    if (!api_key) return res.status(401).json({ error: 'API key required.' });

    const permits = await fetchEnrichedPermits({
      zip,
      minValue: min_value,
      limit: Math.min(Number(limit), 20),
      permitType: permit_type,
      findEmail: true,
    });

    const results = [];
    for (const permit of permits) {
      const result = { permit_number: permit.permit_number, address: permit.address };

      if (!permit.contractor?.email) {
        result.status = 'skipped';
        result.reason = 'no email found';
        results.push(result);
        continue;
      }

      try {
        const drafted = await writeOutreachEmail(permit);
        result.to_email = drafted.to_email;
        result.subject = drafted.subject;

        if (dry_run === 'true') {
          result.status = 'dry_run';
          result.body = drafted.body;
        } else {
          const sent = await sendOutreachEmail(drafted);
          result.status = 'sent';
          result.resend_id = sent.id;
        }
      } catch (e) {
        result.status = 'error';
        result.reason = e.message;
      }

      results.push(result);
    }

    const sent = results.filter((r) => r.status === 'sent').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    res.json({ results, sent, skipped, dry_run: dry_run === 'true' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'FirstNail Permit API',
    description: 'Austin building permits enriched with contractor contact info',
    endpoints: {
      recent: '/permits/recent?api_key=YOUR_KEY',
      high_value: '/permits/high-value?api_key=YOUR_KEY',
      enriched: '/permits/enriched?api_key=YOUR_KEY&min_value=100000&limit=20',
    },
    enriched_fields: ['contractor phone', 'contractor company', 'TDLR license type/number', 'job valuation', 'permit link', 'email (with find_email=true)'],
    email_lookup: '/contractor/find-email?company=NAME&name=FULL_NAME&api_key=YOUR_KEY',
    write_email: 'POST /permits/write-email?api_key=YOUR_KEY — body: enriched permit object',
    send_outreach: 'POST /permits/send-outreach?api_key=YOUR_KEY&min_value=100000&limit=5 — full pipeline',
    quota: '/hunter/quota?api_key=YOUR_KEY',
    note: 'find_email=true on /permits/enriched triggers Hunter.io — uses quota. Results cached permanently per company.',
  });
});

app.listen(PORT, () => {
  console.log(`PermitIQ API running on port ${PORT}`);
  runCheck().catch((err) => console.error('[monitor] startup error:', err.message));
  setInterval(() => {
    runCheck().catch((err) => console.error('[monitor] error:', err.message));
  }, 60 * 60 * 1000);
});