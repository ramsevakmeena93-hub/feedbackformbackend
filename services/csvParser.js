/**
 * Extract Google Drive links from a CSV file.
 * - Each row = one PDF link (even if same link appears multiple times)
 * - Hard cap: max 50 links per batch
 * - Skips empty/invalid rows
 */
function parseCSV(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, ''); 
  const rows = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (rows.length === 0) return [];

  const splitRow = (row) => row.split(/,(?=(?:(?:[^"]*"){2})*[^" ]*$)|[;\t]/)
    .map(c => c.trim().replace(/^["']|["']$/g, ''));

  // 1. Find the actual HEADER row by scanning the first 10 lines
  // We look for a row that contains both "Faculty" and "Response"
  let headerIdx = -1;
  let respIdx = -1;
  let linkIdx = -1;

  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = splitRow(rows[i]).map(c => c.toLowerCase());
    const isHeaderCandidate = cells.some(c => c.includes('faculty') || c.includes('name')) && 
                              cells.some(c => c.includes('respon') || c === 'resp');
    
    if (isHeaderCandidate) {
      headerIdx = i;
      respIdx = cells.findIndex(c => c.includes('respon') || c === 'resp');
      linkIdx = cells.findIndex(c => c.includes('link') || c.includes('drive') || c.includes('url'));
      break;
    }
  }

  const results = [];
  const startRow = headerIdx !== -1 ? headerIdx + 1 : 0;

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const cells = splitRow(row);
     
    // Find Link
    let url = '';
    if (linkIdx !== -1 && cells[linkIdx]?.includes('drive.google.com')) {
      url = cells[linkIdx];
    } else {
      const m = row.match(/https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
      url = m ? m[0] : '';
    }
    if (!url) continue;

    // Find Response Count
    let resp = null;
    // Method A: Use header index if found (Best for your screenshot)
    if (respIdx !== -1 && cells[respIdx]) {
      const raw = cells[respIdx].trim();
      const val = parseInt(raw.replace(/[^\d]/g, ''), 10);
      if (!isNaN(val)) resp = val;
    } 
    
    // Method B: Fallback - look for most likely small number
    if (resp === null) {
      for (let j = cells.length - 1; j > 0; j--) {
        const cellVal = cells[j].replace(/[^\d]/g, '');
        if (cellVal) {
          const val = parseInt(cellVal, 10);
          if (!isNaN(val) && val > 0 && val < 500) {
            resp = val;
            break; 
          }
        }
      }
    }

    results.push({ pdfLink: url, responseCount: resp });
  }

  return results;
}

module.exports = { parseCSV };
