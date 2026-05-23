const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const FacultyReport = require('../models/FacultyReport');
  const reports = await FacultyReport.find({}).select('facultyName subjectCode responseCount ffiScore status');
  console.log(`Found ${reports.length} reports in DB:`);
  reports.forEach(r => {
    console.log(`- Name: ${r.facultyName}, Code: ${r.subjectCode}, ResponseCount: ${r.responseCount}, FFI: ${r.ffiScore}, Status: ${r.status}`);
  });
  mongoose.disconnect();
}).catch(console.error);
