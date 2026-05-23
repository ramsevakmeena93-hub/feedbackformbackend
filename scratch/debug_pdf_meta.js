const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const { convertDriveLink } = require('../services/pdfAnalyzer');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function debug() {
  await mongoose.connect(process.env.MONGO_URI);
  const FacultyReport = require('../models/FacultyReport');
  
  // Find a report with a valid driveLink
  const report = await FacultyReport.findOne({ driveLink: { $regex: /^http/ } });
  if (!report) {
    console.log('No report with http driveLink found!');
    mongoose.disconnect();
    return;
  }
  
  console.log('Found report:', report.facultyName, report.subjectCode);
  console.log('Drive link:', report.driveLink);
  
  try {
    const url = convertDriveLink(report.driveLink);
    console.log('Download URL:', url);
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    const uint8 = new Uint8Array(res.data);
    const doc = await pdfjsLib.getDocument({ data: uint8, verbosity: 0 }).promise;
    console.log('Pages:', doc.numPages);
    
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    
    const items = tc.items
      .filter(i => i.str && i.str.trim())
      .map(i => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5] }));
      
    console.log('--- ALL TEXT ITEMS ---');
    items.forEach(item => {
      console.log(`x: ${item.x.toFixed(1)}, y: ${item.y.toFixed(1)}, str: "${item.str}"`);
    });
  } catch (err) {
    console.error('Error:', err);
  }
  
  mongoose.disconnect();
}

debug();
