const express = require('express');
const axios = require('axios');
const stripe = require('stripe')('mk_1TRmZtJQ1LZaU2VZwUUF0iyd');

const app = express();
const PORT = 3000;

const AUSTIN_API = 'https://data.austintexas.gov/resource/3syk-w9eu.json';

app.use(express.json());

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

app.get('/', (req, res) => {
  res.json({
    name: 'PermitIQ API',
    description: 'Real-time Austin building permit data for AI agents and developers',
    endpoints: {
      recent: '/permits/recent?api_key=YOUR_KEY',
      high_value: '/permits/high-value?api_key=YOUR_KEY',
    },
    pricing: '$0.05 per query',
    signup: 'Email dpcombs2003@gmail.com to get your API key'
  });
});

app.listen(PORT, () => {
  console.log(`PermitIQ API running on port ${PORT}`);
});