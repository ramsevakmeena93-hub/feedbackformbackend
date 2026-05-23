const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  require('./models/FacultyReport');
  const User = require('./models/User');
  const Submission = require('./models/Submission');
  const FacultyReport = require('./models/FacultyReport');

  const sub = await Submission.findOne({ status: 'approved' })
    .populate('hodId', 'name email department signatureImage');

  const vcUser = await User.findOne({ role: 'vc' }).select('name signatureImage');
  const reports = await FacultyReport.find({ hodId: sub.hodId._id });

  console.log('HOD:', sub.hodId.name, '| sig bytes:', sub.hodId.signatureImage ? sub.hodId.signatureImage.length : 0);
  console.log('VC:', vcUser.name, '| sig bytes:', vcUser.signatureImage ? vcUser.signatureImage.length : 0);
  console.log('Reports:', reports.length);
  reports.forEach(r => console.log(' -', r.facultyName, r.subjectCode, 'drive:', r.driveLink ? 'YES' : 'NO'));

  const { generateFeedbackReportPDF } = require('./services/pdfGenerator');
  console.log('\nGenerating PDF...');
  const buf = await generateFeedbackReportPDF({
    submission: sub,
    reports,
    hodUser: sub.hodId,
    vcUser,
    approvedAt: sub.updatedAt
  });

  require('fs').writeFileSync('./demo-output.pdf', buf);
  console.log('\n✓ Demo PDF saved as demo-output.pdf (' + buf.length + ' bytes)');
  console.log('Open it to verify signatures are showing.');
  mongoose.disconnect();
}).catch(e => { console.error('ERROR:', e.message); process.exit(1); });
