const nodemailer = require('nodemailer');

// Lazily create transporter only when SMTP credentials are available
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
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

async function sendExpenseNotification({ members, expense, payers, groupName, isUpdate = false }) {
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
      <p style="color:#64748b;font-size:0.8rem;margin:0">You receive this because you are a member of the group. <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color:#14b8a6">Open SplitEase</a></p>
    </div>
  `;

  // Send to all members
  for (const member of members) {
    if (member.email) {
      await sendMail(member.email, subject, html);
    }
  }
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

  if (payeeEmail) await sendMail(payeeEmail, payeeSubject, payeeHtml);
  if (payerEmail) await sendMail(payerEmail, payerSubject, payerHtml);
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
