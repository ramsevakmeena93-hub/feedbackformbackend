
const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function run() {
  const data = fs.readFileSync('C:/Users/Hp/OneDrive/Desktop/Feedbackform/demo-report.pdf');
  const pdfDoc = await PDFDocument.load(data);
  const rawUint8 = new Uint8Array(data);
  const pdfJsDoc = await pdfjsLib.getDocument({ data: rawUint8 }).promise;

  let sigPageIdx = null;
  let facItem = null;
  let hodItem = null;
  let vcItem = null;

  for (let pi = 1; pi <= pdfJsDoc.numPages; pi++) {
    const pg = await pdfJsDoc.getPage(pi);
    const tc = await pg.getTextContent();
    
    const foundHod = tc.items.find(item => item.str.trim() === 'HOD');
    if (foundHod) {
      sigPageIdx = pi - 1;
      hodItem = foundHod;
      facItem = tc.items.find(item => item.str.trim().includes('Faculty') && item.str.trim().includes('Signature'));
      vcItem = tc.items.find(item => item.str.trim() === 'PRO - VC' || item.str.trim() === 'PRO-VC' || item.str.trim() === 'PRO - VC ');
      break;
    }
  }

  if (sigPageIdx !== null) {
    const targetPage = pdfDoc.getPage(sigPageIdx);
    const SIG_W = 75;

    const baseY = hodItem ? hodItem.transform[5] : 100;
    
    const drawSigBox = (labelItem, defaultX, label) => {
      const itemX = labelItem ? labelItem.transform[4] : null;
      const itemW = labelItem ? (labelItem.width || 0) : null;
      const itemY = labelItem ? labelItem.transform[5] : baseY;
      
      const x = (itemX !== null && itemW !== null) ? itemX + itemW + 10 : defaultX;
      const h = 22;
      const y = itemY - 6;
      
      // Draw a black box to represent the signature
      targetPage.drawRectangle({ x, y, width: SIG_W, height: h, color: rgb(0.2, 0.2, 0.2) });
      targetPage.drawText(label, { x: x + 5, y: y + 5, size: 10, color: rgb(1, 1, 1) });
    };

    drawSigBox(facItem, 130, 'FACULTY');
    drawSigBox(hodItem, 360, 'HOD');
    drawSigBox(vcItem, 500, 'VC');

    console.log('[PDF] Stamped sigs inline on page ' + (sigPageIdx+1));
  }
  fs.writeFileSync('C:/Users/Hp/.gemini/antigravity/brain/02069b8e-5aa1-4b49-a5b3-56240e76acae/test_signature_demo.pdf', await pdfDoc.save());
  console.log('Done!');
}
run().catch(console.error);

