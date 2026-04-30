const axios = require('axios');
const { lookupContractor, isReady } = require('./db');
const { findContractorEmail } = require('./find-email');

const AUSTIN_API = 'https://data.austintexas.gov/resource/3syk-w9eu.json';

// Permit types most relevant to lumber yard leads (new construction + major rework)
const HIGH_VALUE_TYPES = new Set(['BP', 'BC', 'BU', 'PP', 'EP', 'MP', 'RB']);

function enrichPermit(permit, emailResult = null) {
  const tdlr = isReady() ? lookupContractor(permit) : null;

  return {
    permit_number: permit.permit_number,
    permit_type: permit.permit_type_desc,
    work_class: permit.work_class,
    address: permit.original_address1,
    city: permit.original_city,
    zip: permit.original_zip,
    issued_date: permit.issue_date,
    job_valuation: permit.total_job_valuation ? Number(permit.total_job_valuation) : null,
    description: permit.description,
    permit_link: permit.link?.url || null,

    contractor: {
      company_name: permit.contractor_company_name || tdlr?.business_name || null,
      full_name: permit.contractor_full_name || tdlr?.individual_name || null,
      phone: permit.contractor_phone || tdlr?.business_phone || tdlr?.individual_phone || null,
      trade: permit.contractor_trade || null,
      address: permit.contractor_address1 || null,
      city: permit.contractor_city || null,
      zip: permit.contractor_zip || tdlr?.business_zip || null,
      email: emailResult?.email ?? null,
      email_domain: emailResult?.domain ?? null,
      email_confidence: emailResult?.confidence ?? null,
    },

    applicant: {
      full_name: permit.applicant_full_name || null,
      org: permit.applicant_org || null,
      phone: permit.applicant_phone || null,
    },

    tdlr_match: tdlr ? {
      license_type: tdlr.license_type,
      license_number: tdlr.license_number,
      license_subtype: tdlr.license_subtype,
      expiration_date: tdlr.expiration_date,
    } : null,
  };
}

async function fetchEnrichedPermits({ zip, minValue, since, limit = 20, permitType, findEmail = false } = {}) {
  const where = [];
  if (minValue) where.push(`total_job_valuation > '${Number(minValue)}'`);
  if (zip) where.push(`original_zip = '${zip}'`);
  if (permitType) {
    const types = Array.isArray(permitType) ? permitType : [permitType];
    where.push(`permittype in (${types.map((t) => `'${t}'`).join(',')})`);
  }
  // Socrata floating_timestamp doesn't accept timezone suffix — strip it
  if (since) where.push(`issue_date > '${since.replace('Z', '').replace(/\.\d+$/, '.000')}'`);

  let url = `${AUSTIN_API}?$limit=${limit}&$order=issue_date DESC`;
  if (where.length > 0) url += `&$where=${encodeURIComponent(where.join(' AND '))}`;

  const { data } = await axios.get(url);

  if (!findEmail) return data.map((p) => enrichPermit(p));

  // findEmail=true: look up each contractor's email sequentially to respect rate limits
  const results = [];
  for (const permit of data) {
    let emailResult = null;
    const company = permit.contractor_company_name;
    const name = permit.contractor_full_name;
    if (company || name) {
      try {
        emailResult = await findContractorEmail(company, name);
      } catch (e) {
        // quota exhausted or network error — continue without email
        if (e.response?.status === 429) {
          console.warn('Hunter.io quota exhausted');
          results.push(enrichPermit(permit, null));
          for (const remaining of data.slice(results.length)) results.push(enrichPermit(remaining, null));
          break;
        }
      }
    }
    results.push(enrichPermit(permit, emailResult));
  }
  return results;
}

module.exports = { enrichPermit, fetchEnrichedPermits };
