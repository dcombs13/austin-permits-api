const { Resend } = require('resend');

const FROM_ADDRESS = 'Mike Patterson <mike@austinlumbersupply.com>';
const REPLY_TO = 'mike@austinlumbersupply.com';

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  return new Resend(apiKey);
}

// Returns the Resend send response { id } on success.
async function sendOutreachEmail({ to_name, to_email, subject, body }) {
  if (!to_email) throw new Error('No recipient email address');

  const resend = getResend();
  const to = to_name ? `${to_name} <${to_email}>` : to_email;

  const { data, error } = await resend.emails.send({
    from: FROM_ADDRESS,
    reply_to: REPLY_TO,
    to,
    subject,
    text: body,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  return data;
}

module.exports = { sendOutreachEmail };
