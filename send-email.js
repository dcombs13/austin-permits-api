const { Resend } = require('resend');

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  return new Resend(apiKey);
}

// Returns the Resend send response { id } on success.
// sender_name, sender_email, sender_company identify the lumber yard owner.
// From uses their display name; Reply-To routes replies to their real inbox.
async function sendOutreachEmail({ to_name, to_email, subject, body, sender_name, sender_email, sender_company }) {
  if (!to_email) throw new Error('No recipient email address');
  if (!sender_email) throw new Error('No sender email address');

  const resend = getResend();
  const to = to_name ? `${to_name} <${to_email}>` : to_email;
  const fromDisplay = sender_company ? `${sender_name}, ${sender_company}` : sender_name;
  const from = `${fromDisplay} <${sender_email}>`;

  const { data, error } = await resend.emails.send({
    from,
    reply_to: sender_email,
    to,
    subject,
    text: body,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  return data;
}

module.exports = { sendOutreachEmail };
