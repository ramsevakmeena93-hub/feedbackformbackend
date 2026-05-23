const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function extractText() {
  const pdfPath = path.join(__dirname, '../../../demo-report.pdf');
  const uint8 = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data: uint8, verbosity: 0 }).promise;
  console.log('Number of pages:', doc.numPages);
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items.map(item => item.str).join(' ');
    console.log(`--- Page ${i} ---`);
    console.log(text.substring(0, 1000));
  }
}

extractText().catch(console.error);
