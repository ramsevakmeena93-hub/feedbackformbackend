const fs = require('fs');
const path = require('path');
const { analyzePDFBuffer } = require('../services/pdfAnalyzer');

async function test() {
  try {
    const pdfPath = path.join(__dirname, '../../../demo-report.pdf');
    console.log('Reading:', pdfPath);
    const buffer = fs.readFileSync(pdfPath);
    const result = await analyzePDFBuffer(buffer);
    console.log('Result meta:', JSON.stringify(result.meta, null, 2));
    console.log('Result ffiScore:', result.ffiScore);
    console.log('Result responseCount:', result.responseCount);
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
