const nodemailer = require('nodemailer');

// Lazily create transporter only when SMTP credentials are available
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;

  _transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,          // STARTTLS — port 587 is open on Render free tier
    requireTLS: true,       // force upgrade to TLS after connecting
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false,  // avoids cert issues on some hosting envs
    },
  });
  return _transporter;
}

async function sendMail(to, subject, html) {
  const transporter = getTransporter();
  if (!transporter) return; // silently skip if not configured

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || `SplitEase <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.warn('Email send failed (non-fatal):', err.message);
  }
}

/**
 * Send expense notification.
 *
 * @param {object}   opts
 * @param {Array}    opts.members        - All group members [{id, name, email}]
 * @param {Set}      opts.involvedUserIds - User IDs involved in the expense (payers + splittees)
 * @param {number}   opts.currentUserId  - The user who triggered the action (excluded from emails)
 * @param {object}   opts.expense
 * @param {Array}    opts.payers
 * @param {string}   opts.groupName
 * @param {boolean}  opts.isUpdate
 */
async function sendExpenseNotification({ members, involvedUserIds, currentUserId, expense, payers, groupName, isUpdate = false }) {
  const payerSummary = payers.map(p => `${p.user_name || p.name}: ₹${Number(p.amount_paid).toFixed(2)}`).join(', ');
  const action = isUpdate ? 'updated' : 'added';
  const actionLabel = isUpdate ? '✏️ Expense Updated' : '💸 New Expense';
  const subject = `[SplitEase] Expense ${action} in "${groupName}"`;
  const html = `
    <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;background:#0a0e17;color:#f1f5f9;padding:24px;border-radius:12px">
      <h2 style="color:#14b8a6;margin:0 0 4px">${actionLabel}</h2>
      <p style="color:#94a3b8;margin:0 0 20px;font-size:0.9rem">In group <strong style="color:#f1f5f9">${groupName}</strong></p>
      <div style="background:#1a2332;border-radius:10px;padding:16px;margin-bottom:16px">
        <div style="font-size:1.1rem;font-weight:700;margin-bottom:6px">${expense.description}</div>
        <div style="color:#14b8a6;font-size:1.6rem;font-weight:800">₹${Number(expense.amount).toFixed(2)}</div>
        <div style="color:#94a3b8;font-size:0.85rem;margin-top:6px">Paid by: <span style="color:#f1f5f9">${payerSummary}</span></div>
        <div style="color:#94a3b8;font-size:0.85rem">Category: ${expense.category_icon || ''} ${expense.category_name || 'Other'} &nbsp;·&nbsp; ${expense.date}</div>
      </div>
      <p style="color:#64748b;font-size:0.8rem;margin:0">You receive this because you are involved in this expense. <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color:#14b8a6">Open SplitEase</a></p>
    </div>
  `;

  // Send only to INVOLVED members (payers + splittees), excluding the current user
  const recipients = members.filter(m => {
    if (!m.email) return false;
    if (m.id === currentUserId) return false;  // don't notify the person who made the change
    if (involvedUserIds && involvedUserIds.size > 0) {
      return involvedUserIds.has(Number(m.id));
    }
    return true;
  });

  // Send all emails in parallel
  await Promise.allSettled(
    recipients.map(member => sendMail(member.email, subject, html))
  );
}

async function sendSettlementNotification({ payerEmail, payerName, payeeEmail, payeeName, amount, groupName }) {
  // Email to payee: you received money
  const payeeSubject = `[SplitEase] ${payerName} paid you ₹${Number(amount).toFixed(2)} in "${groupName}"`;
  const payeeHtml = `
    <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;background:#0a0e17;color:#f1f5f9;padding:24px;border-radius:12px">
      <h2 style="color:#10b981;margin:0 0 4px">🎉 Payment Received</h2>
      <p style="color:#94a3b8;margin:0 0 20px;font-size:0.9rem">Settlement in <strong style="color:#f1f5f9">${groupName}</strong></p>
      <div style="background:#1a2332;border-radius:10px;padding:16px">
        <div style="color:#94a3b8;font-size:0.95rem"><strong style="color:#f1f5f9">${payerName}</strong> paid you</div>
        <div style="color:#10b981;font-size:1.8rem;font-weight:800;margin:8px 0">₹${Number(amount).toFixed(2)}</div>
      </div>
      <p style="color:#64748b;font-size:0.8rem;margin-top:16px"><a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color:#14b8a6">Open SplitEase</a> to view updated balances.</p>
    </div>
  `;

  // Email to payer: confirmation you paid
  const payerSubject = `[SplitEase] You settled up with ${payeeName} in "${groupName}"`;
  const payerHtml = `
    <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;background:#0a0e17;color:#f1f5f9;padding:24px;border-radius:12px">
      <h2 style="color:#14b8a6;margin:0 0 4px">✅ Settlement Confirmed</h2>
      <p style="color:#94a3b8;margin:0 0 20px;font-size:0.9rem">Settlement in <strong style="color:#f1f5f9">${groupName}</strong></p>
      <div style="background:#1a2332;border-radius:10px;padding:16px">
        <div style="color:#94a3b8;font-size:0.95rem">You paid <strong style="color:#f1f5f9">${payeeName}</strong></div>
        <div style="color:#14b8a6;font-size:1.8rem;font-weight:800;margin:8px 0">₹${Number(amount).toFixed(2)}</div>
      </div>
      <p style="color:#64748b;font-size:0.8rem;margin-top:16px"><a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color:#14b8a6">Open SplitEase</a> to view updated balances.</p>
    </div>
  `;

  await Promise.allSettled([
    payeeEmail ? sendMail(payeeEmail, payeeSubject, payeeHtml) : Promise.resolve(),
    payerEmail ? sendMail(payerEmail, payerSubject, payerHtml) : Promise.resolve(),
  ]);
}

async function sendInvitationEmail({ toEmail, inviterName, groupName, inviteUrl }) {
  const subject = `${inviterName} invited you to "${groupName}" on SplitEase`;
  const html = `
    <div style="font-family:Inter,sans-serif;max-width:500px;margin:auto;background:#0a0e17;color:#f1f5f9;padding:24px;border-radius:12px">
      <h2 style="color:#14b8a6;margin:0 0 4px">💸 SplitEase Invitation</h2>
      <p style="color:#94a3b8;margin:0 0 20px"><strong style="color:#f1f5f9">${inviterName}</strong> invited you to join <strong style="color:#f1f5f9">${groupName}</strong>.</p>
      <a href="${inviteUrl}" style="display:inline-block;background:#14b8a6;color:#0a0e17;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem">Accept Invitation →</a>
      <p style="color:#64748b;font-size:0.8rem;margin-top:20px">If you don't have a SplitEase account yet, you'll be asked to create one first.</p>
      <p style="color:#64748b;font-size:0.8rem">Or copy this link: <a href="${inviteUrl}" style="color:#14b8a6">${inviteUrl}</a></p>
    </div>
  `;
  await sendMail(toEmail, subject, html);
}

module.exports = { sendExpenseNotification, sendSettlementNotification, sendInvitationEmail };
