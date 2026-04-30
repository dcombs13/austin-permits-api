const express = require('express');
const axios = require('axios');

const app = express();
const PORT = 3000;

const AUSTIN_API = 'https://data.austintexas.gov/resource/3syk-w9eu.json';

app.get('/permits/recent', async (req, res) => {
  try {
    const { zip, limit = 10 } = req.query;
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
    const { min = 500000, limit = 10 } = req.query;
    const url = `${AUSTIN_API}?$where=total_job_valuation > '${min}'&$limit=${limit}&$order=total_job_valuation DESC`;
    const { data } = await axios.get(url);
    res.json({ results: data, count: data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Austin Permits API running on port ${PORT}`);
  console.log(`Try: http://localhost:3000/permits/recent`);
});