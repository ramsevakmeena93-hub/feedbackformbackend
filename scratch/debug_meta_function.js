const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { convertDriveLink } = require('../services/pdfAnalyzer');

async function extractMetaFromBufferDebug(buffer) {
  const uint8 = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data: uint8, verbosity: 0 }).promise;

  // Read first page — header table is always there
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();

  // Group text items by Y row (within 4px tolerance)
  const items = tc.items
    .filter(i => i.str && i.str.trim())
    .map(i => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5] }));

  // Build rows: { yKey -> [{str, x}] } sorted by x
  const rowMap = {};
  items.forEach(item => {
    const yKey = Math.round(item.y / 4) * 4;
    if (!rowMap[yKey]) rowMap[yKey] = [];
    rowMap[yKey].push(item);
  });

  // Sort each row by x position
  Object.values(rowMap).forEach(row => row.sort((a, b) => a.x - b.x));

  // Find the header row containing "Faculty" and "Name" and "Course"
  let headerY = null;
  let dataY = null;

  const yKeys = Object.keys(rowMap).map(Number).sort((a, b) => b - a); // top to bottom

  for (const y of yKeys) {
    const rowText = rowMap[y].map(i => i.str.toLowerCase()).join(' ');
    if (rowText.includes('faculty') && (rowText.includes('code') || rowText.includes('subject')) && (rowText.includes('semester') || rowText.includes('sem') || rowText.includes('programme'))) {
      headerY = y;
      const lowerRows = yKeys.filter(k => k < y).sort((a, b) => b - a);
      for (const ky of lowerRows) {
        if (rowMap[ky].length >= 5) {
          dataY = ky;
          break;
        }
      }
      break;
    }
  }

  console.log('headerY:', headerY, 'dataY:', dataY);
  
  if (headerY && dataY) {
    const headerItems = rowMap[headerY];
    const dataRowItems = rowMap[dataY] || [];
    const ffiItem = dataRowItems.filter(i => /^\d+\.\d+$/.test(i.str)).sort((a, b) => b.x - a.x)[0];
    const ffiScore = ffiItem ? parseFloat(ffiItem.str) : null;
    const ffiX = ffiItem ? ffiItem.x : 540;

    let responseHeaderX = null;
    const respHeaderItem = headerItems.find(i => {
      const s = i.str.toLowerCase();
      return (s.includes('respon') || s === 'resp') && !s.includes('%');
    });
    if (respHeaderItem) {
      responseHeaderX = respHeaderItem.x;
      console.log('Found Response Header at X:', responseHeaderX);
    }

    let responseCount = null;
    if (responseHeaderX !== null) {
      const respItem = dataRowItems.find(i => Math.abs(i.x - responseHeaderX) < 15);
      if (respItem) {
        const val = parseInt(respItem.str.replace(/[^\d]/g, ''), 10);
        if (!isNaN(val)) responseCount = val;
      }
    }

    if (responseCount === null) {
      // Fallback: search for integers to the left of FFI, sorted descending by X (closest to FFI first)
      const respItem = dataRowItems
        .filter(i => i.x < ffiX - 10 && i.x > ffiX - 250 && /^\d+$/.test(i.str))
        .sort((a, b) => b.x - a.x)[0];
      if (respItem) {
        responseCount = parseInt(respItem.str, 10);
      }
    }
    
    console.log('Detected ffiScore:', ffiScore);
    console.log('Detected responseCount:', responseCount);
  }
}

async function test() {
  const url = convertDriveLink("https://drive.google.com/file/d/12foW0dOpr5WJGDGMVFBm13ffalmm0w-P/view?usp=sharing");
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  await extractMetaFromBufferDebug(res.data);
}

test().catch(console.error);
