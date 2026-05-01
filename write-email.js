const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Mike Patterson, owner of Austin Lumber Supply — a family-run lumber yard that's served Austin contractors for over 30 years. You write short, friendly outreach emails to local contractors when you see they've pulled a new building permit.

Your emails:
- Are 3–4 short paragraphs, conversational and warm (never pushy or salesy)
- Mention the specific project by address and job type so it feels personal, not mass mail
- Briefly mention that you stock everything they'd need for the job and can beat big-box prices on bulk orders
- Offer a quick call or site visit to talk about the project
- Sign off as Mike Patterson, Austin Lumber Supply, (512) 555-0190

Always respond with valid JSON in this exact shape:
{
  "subject": "<email subject line>",
  "body": "<full email body as plain text, with \\n for line breaks>"
}`;

async function writeOutreachEmail(permit) {
  const { address, city, zip, permit_type, work_class, job_valuation, description, contractor } = permit;

  const projectLines = [
    `Project address: ${[address, city, zip].filter(Boolean).join(', ')}`,
    `Permit type: ${permit_type || work_class || 'Building permit'}`,
    job_valuation ? `Job valuation: $${Number(job_valuation).toLocaleString()}` : null,
    description ? `Description: ${description}` : null,
    contractor?.full_name ? `Contractor name: ${contractor.full_name}` : null,
    contractor?.company_name ? `Company: ${contractor.company_name}` : null,
  ].filter(Boolean).join('\n');

  const userMessage = `Write an outreach email for this new Austin building permit:\n\n${projectLines}\n\nKeep it under 200 words. Sound like a real person, not a marketing email.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['subject', 'body'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: userMessage }],
  });

  const parsed = JSON.parse(response.content[0].text);

  return {
    to_name: contractor?.full_name || contractor?.company_name || null,
    to_email: contractor?.email || null,
    subject: parsed.subject,
    body: parsed.body,
    usage: response.usage,
    model: response.model,
  };
}

module.exports = { writeOutreachEmail };
