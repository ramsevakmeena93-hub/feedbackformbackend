const nodemailer = require('nodemailer');

// ── Transporter (configured via .env) ────────────────────────
function createTransporter() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[Email] EMAIL_USER or EMAIL_PASS not set — emails disabled');
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

async function sendEmail({ to, subject, html }) {
  const transporter = createTransporter();
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: `"MITS Feedback System" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
    console.log(`[Email] Sent to ${to}: ${subject}`);
  } catch (err) {
    console.error('[Email] Failed:', err.message);
  }
}

const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:5176';

// ── Email Templates ───────────────────────────────────────────

// 1. HOD sends reports to faculty
async function emailFacultyReportReady({ facultyEmail, facultyName, hodName, department, subjectCode }) {
  await sendEmail({
    to: facultyEmail,
    subject: `Your Feedback Report is Ready — ${subjectCode || 'MITS'}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:8px;">
        <div style="background:#1a3a6e;padding:20px;border-radius:6px 6px 0 0;text-align:center;">
          <h2 style="color:white;margin:0;">MITS Faculty Feedback System</h2>
        </div>
        <div style="padding:24px;">
          <p>Dear <strong>${facultyName}</strong>,</p>
          <p>Your faculty feedback report for <strong>${subjectCode || 'your subject'}</strong> has been processed and is ready for your review.</p>
          <p><strong>Submitted by HOD:</strong> ${hodName} — ${department}</p>
          <p>Please login to the Faculty Portal to view your report and acknowledge it with your signature.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${BASE_URL}/landing" style="background:#1a3a6e;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">
              Login to Faculty Portal
            </a>
          </div>
          <p style="color:#666;font-size:13px;">If you have any questions, contact your HOD.</p>
        </div>
        <div style="background:#f5f5f5;padding:12px;text-align:center;font-size:12px;color:#999;border-radius:0 0 6px 6px;">
          © 2025 Madhav Institute of Technology & Science, Gwalior
        </div>
      </div>
    `,
  });
}

// 2. Faculty approves/acknowledges → notify HOD
async function emailHODFacultyApproved({ hodEmail, hodName, facultyName, subjectCode, department }) {
  await sendEmail({
    to: hodEmail,
    subject: `Faculty Approved Report — ${facultyName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:8px;">
        <div style="background:#1a3a6e;padding:20px;border-radius:6px 6px 0 0;text-align:center;">
          <h2 style="color:white;margin:0;">MITS Faculty Feedback System</h2>
        </div>
        <div style="padding:24px;">
          <p>Dear <strong>${hodName}</strong>,</p>
          <p style="color:#2e7d32;font-weight:bold;">✅ A faculty member has approved their feedback report.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f9f9f9;font-weight:bold;">Faculty</td><td style="padding:8px;border:1px solid #ddd;">${facultyName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f9f9f9;font-weight:bold;">Subject</td><td style="padding:8px;border:1px solid #ddd;">${subjectCode || '—'}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f9f9f9;font-weight:bold;">Department</td><td style="padding:8px;border:1px solid #ddd;">${department || '—'}</td></tr>
          </table>
          <p>All approved reports can now be submitted to the Vice Chancellor.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${BASE_URL}/landing" style="background:#1a3a6e;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">
              Login to HOD Portal
            </a>
          </div>
        </div>
        <div style="background:#f5f5f5;padding:12px;text-align:center;font-size:12px;color:#999;border-radius:0 0 6px 6px;">
          © 2025 Madhav Institute of Technology & Science, Gwalior
        </div>
      </div>
    `,
  });
}

// 3. VC approves → notify HOD with PDF download link
async function emailHODVCApproved({ hodEmail, hodName, department, academicYear, session, submissionId }) {
  const downloadUrl = `${BASE_URL}/hod/history`;
  await sendEmail({
    to: hodEmail,
    subject: `✅ VC Approved Your Submission — ${academicYear} ${session}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:8px;">
        <div style="background:#1a3a6e;padding:20px;border-radius:6px 6px 0 0;text-align:center;">
          <h2 style="color:white;margin:0;">MITS Faculty Feedback System</h2>
          <p style="color:#c8a951;margin:4px 0 0;font-size:14px;">Official Approval Notice</p>
        </div>
        <div style="padding:24px;">
          <p>Dear <strong>${hodName}</strong>,</p>
          <p style="color:#2e7d32;font-weight:bold;font-size:16px;">🎉 The Vice Chancellor has APPROVED your faculty feedback submission.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f9f9f9;font-weight:bold;">Department</td><td style="padding:8px;border:1px solid #ddd;">${department}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f9f9f9;font-weight:bold;">Academic Year</td><td style="padding:8px;border:1px solid #ddd;">${academicYear}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;background:#f9f9f9;font-weight:bold;">Session</td><td style="padding:8px;border:1px solid #ddd;">${session === 'jan-may' ? 'January – June' : 'July – December'}</td></tr>
          </table>
          <p>Your final Action Taken Report PDF is now available for download from the History section.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${downloadUrl}" style="background:#2e7d32;color:white;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:15px;">
              📥 Download Final PDF Report
            </a>
          </div>
          <p style="color:#666;font-size:13px;">Login to the HOD portal and go to History section to download semester-wise PDFs.</p>
        </div>
        <div style="background:#f5f5f5;padding:12px;text-align:center;font-size:12px;color:#999;border-radius:0 0 6px 6px;">
          © 2025 Madhav Institute of Technology & Science, Gwalior
        </div>
      </div>
    `,
  });
}

// 4. VC rejects → notify HOD
async function emailHODVCRejected({ hodEmail, hodName, department, academicYear, vcComment }) {
  await sendEmail({
    to: hodEmail,
    subject: `❌ VC Rejected Your Submission — ${academicYear}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #e0e0e0;border-radius:8px;">
        <div style="background:#c62828;padding:20px;border-radius:6px 6px 0 0;text-align:center;">
          <h2 style="color:white;margin:0;">MITS Faculty Feedback System</h2>
        </div>
        <div style="padding:24px;">
          <p>Dear <strong>${hodName}</strong>,</p>
          <p style="color:#c62828;font-weight:bold;">❌ The Vice Chancellor has rejected your submission for ${department} — ${academicYear}.</p>
          ${vcComment ? `<div style="background:#fff3f3;border-left:4px solid #c62828;padding:12px;margin:16px 0;"><strong>Reason:</strong> ${vcComment}</div>` : ''}
          <p>Please review the feedback, make necessary corrections, and resubmit.</p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${BASE_URL}/landing" style="background:#1a3a6e;color:white;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;">
              Login to HOD Portal
            </a>
          </div>
        </div>
        <div style="background:#f5f5f5;padding:12px;text-align:center;font-size:12px;color:#999;border-radius:0 0 6px 6px;">
          © 2025 Madhav Institute of Technology & Science, Gwalior
        </div>
      </div>
    `,
  });
}

module.exports = {
  emailFacultyReportReady,
  emailHODFacultyApproved,
  emailHODVCApproved,
  emailHODVCRejected,
};
