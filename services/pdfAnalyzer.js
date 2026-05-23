const axios = require('axios');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
pdfjsLib.GlobalWorkerOptions.workerSrc = false;

// ─────────────────────────────────────────────────────────────────
// COLOR DETECTION  (values are 0-255 integers in this PDF)
// ─────────────────────────────────────────────────────────────────
function detectColor(r, g, b) {
  // Normalize to 0-255 if 0-1 floats
  if (r <= 1 && g <= 1 && b <= 1 && (r > 0 || g > 0 || b > 0)) {
    r = Math.round(r * 255); g = Math.round(g * 255); b = Math.round(b * 255);
  }
  if (r >= 200 && g <= 80  && b <= 80)  return 'red';    // #FF0000
  if (r >= 200 && g >= 180 && b <= 80)  return 'yellow'; // #FFFF00
  return null;
}

// ─────────────────────────────────────────────────────────────────
// PARSE constructPath args to get bounding rect
// constructPath args[1] = [x, y, w, h]  (rectangle variant)
// args[2] = [x1, y1, x2, y2]            (bounds)
// ─────────────────────────────────────────────────────────────────
function parseBoundsFromConstructPath(args) {
  if (!args || !Array.isArray(args)) return null;

  // args[1] = [x, y, w, h] — the actual rect parameters (most reliable)
  if (args[1] && args[1].length === 4) {
    const [x, y, w, h] = args[1];
    const absW = Math.abs(w), absH = Math.abs(h);
    return { x1: x, y1: y, x2: x + absW, y2: y + absH };
  }
  // Fallback: args[2] = [x1, y1, x2, y2]
  if (args[2] && args[2].length === 4) {
    const [x1, y1, x2, y2] = args[2];
    return { x1: Math.min(x1,x2), y1: Math.min(y1,y2), x2: Math.max(x1,x2), y2: Math.max(y1,y2) };
  }
  return null;
}

function pushUnique(arr, value) {
  const clean = (value || '').trim().replace(/\s+/g, ' ');
  if (clean.length > 2 && !arr.includes(clean)) arr.push(clean);
}

// ─────────────────────────────────────────────────────────────────
// CORE: Find colored background rects, then collect text inside them
// Pattern in this PDF:
//   setFillRGBColor(R,G,B)  ← colored background
//   constructPath(...)       ← rect bounds
//   eoFill                   ← draw the rect
//   ... (save/restore/clip)
//   beginText → showText(black text on top) → endText
// ─────────────────────────────────────────────────────────────────
async function extractHighlightedText(buffer) {
  const appreciation = [];
  const commentsNeedingAttention = [];

  const uint8 = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data: uint8, verbosity: 0 }).promise;
  const OPS = pdfjsLib.OPS;
  const opNames = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const ops = await page.getOperatorList();

    // Get all text items with positions
    const tc = await page.getTextContent();
    const textItems = tc.items
      .filter(i => i.str && i.str.trim())
      .map(i => ({
        str: i.str,
        x: i.transform[4],
        y: i.transform[5],
        w: i.width || 0,
        h: i.height || 10
      }));

    // Step 1: collect all colored background rects on this page
    const coloredRects = []; // { color, x1, y1, x2, y2 }
    let pendingColor = null;

    for (let i = 0; i < ops.fnArray.length; i++) {
      const name = opNames[ops.fnArray[i]] || String(ops.fnArray[i]);
      const args = ops.argsArray[i];

      if (name === 'setFillRGBColor') {
        pendingColor = detectColor(args[0], args[1], args[2]);
      }
      if (name === 'setFillGray') {
        pendingColor = null; // gray = not colored
      }

      // constructPath followed by eoFill/fill = colored rectangle
      if ((name === 'eoFill' || name === 'fill' || name === 'fillStroke' || name === 'eoFillStroke') && pendingColor) {
        // Look back for the most recent constructPath
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const prevName = opNames[ops.fnArray[j]] || String(ops.fnArray[j]);
          if (prevName === 'constructPath') {
            const bounds = parseBoundsFromConstructPath(ops.argsArray[j]);
            if (bounds) {
              const w = bounds.x2 - bounds.x1;
              const h = bounds.y2 - bounds.y1;
              // Only capture single-line highlight rects (height 5-40px)
              // Ignore large container rects (table backgrounds, section boxes)
              if (w > 20 && h >= 5 && h <= 60) {
                coloredRects.push({ color: pendingColor, ...bounds });
              }
            }
            break;
          }
          // Also handle rectangle operator
          if (prevName === 'rectangle') {
            const [rx, ry, rw, rh] = ops.argsArray[j];
            if (Math.abs(rw) > 20 && Math.abs(rh) >= 5 && Math.abs(rh) <= 60) {
              coloredRects.push({
                color: pendingColor,
                x1: rx, y1: ry,
                x2: rx + Math.abs(rw), y2: ry + Math.abs(rh)
              });
            }
            break;
          }
        }
        pendingColor = null;
      }
    }

    // Step 2: for each colored rect, find text items whose position falls inside it
    for (const rect of coloredRects) {
      const margin = 6;
      const inside = textItems.filter(t => {
        // Text y in PDF is baseline — check if it's within the rect vertically
        return t.x >= rect.x1 - margin && t.x <= rect.x2 + margin &&
               t.y >= rect.y1 - margin && t.y <= rect.y2 + margin;
      });

      if (inside.length === 0) continue;

      const text = inside.map(t => t.str).join(' ').trim().replace(/\s+/g, ' ');
      if (text.length < 3) continue;

      if (rect.color === 'red') pushUnique(appreciation, text);
      else if (rect.color === 'yellow') pushUnique(commentsNeedingAttention, text);
    }
  }

  console.log(`\n[PDF Analyzer] RED (appreciation): ${appreciation.length}`);
  appreciation.forEach((t, i) => console.log(`  [${i+1}] ${t}`));
  console.log(`[PDF Analyzer] YELLOW (attention): ${commentsNeedingAttention.length}`);
  commentsNeedingAttention.forEach((t, i) => console.log(`  [${i+1}] ${t}`));

  return { appreciation, commentsNeedingAttention };
}

// ─────────────────────────────────────────────────────────────────
// FILTER: Is this text a real student comment?
// Rejects: page numbers, dates, URLs, table headers, metadata
// ─────────────────────────────────────────────────────────────────
function isValidComment(text) {
  if (!text || text.length < 4) return false;

  // Reject page numbers like "1 / 3", "2/3"
  if (/^\d+\s*\/\s*\d+$/.test(text)) return false;

  // Reject dates like "4/7/26, 5:05 PM"
  if (/\d+\/\d+\/\d+/.test(text) && text.length < 30) return false;

  // Reject URLs
  if (/about:blank|http|www\./.test(text)) return false;

  // Reject table header keywords
  const tableKeywords = ['faculty name', 'course code', 'course name', 'semester', 'registered',
    'response', 'submitted answers', 'print out', 'institute', 'department', 'technology',
    'signature', 'hod', 'pro - vc', 'ffi & suggestion', 'student feedback comments',
    'batch -', 'batch-a', 'batch-b'];
  const lower = text.toLowerCase();
  if (tableKeywords.some(kw => lower.includes(kw))) return false;

  // Reject lines that are mostly numbers (table data rows)
  const numbers = text.match(/\d+/g) || [];
  const words = text.split(/\s+/);
  if (numbers.length > words.length * 0.6) return false;

  // Must have at least 2 real words with letters
  const realWords = words.filter(w => /[a-zA-Z]{2,}/.test(w));
  if (realWords.length < 2) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────
// EXTRACT ALL STUDENT COMMENTS FROM PDF TEXT
// Student comments appear below the main feedback table.
// We find the "Student Feedback Comments" section and extract
// all text lines below it.
// ─────────────────────────────────────────────────────────────────
async function extractAllStudentComments(buffer) {
  const uint8 = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data: uint8, verbosity: 0 }).promise;
  const comments = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();

    // Group text items by Y row — use tighter tolerance (2px) to keep same-line items together
    const items = tc.items
      .filter(i => i.str && i.str.trim())
      .map(i => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5] }));

    const rowMap = {};
    items.forEach(item => {
      const yKey = Math.round(item.y / 2) * 2; // 2px tolerance
      if (!rowMap[yKey]) rowMap[yKey] = [];
      rowMap[yKey].push(item);
    });

    const yKeys = Object.keys(rowMap).map(Number).sort((a, b) => b - a);

    // Find the "Student Feedback Comments" header row
    let commentSectionY = null;
    for (const y of yKeys) {
      const rowText = rowMap[y].map(i => i.str).join(' ').toLowerCase();
      if (rowText.includes('student') && rowText.includes('feedback') && rowText.includes('comment')) {
        commentSectionY = y;
        break;
      }
      if (rowText.includes('ffi') && rowText.includes('suggestion')) {
        commentSectionY = y;
        break;
      }
    }

    const startY = commentSectionY !== null ? commentSectionY : null;
    const commentRows = startY !== null
      ? yKeys.filter(k => k < startY)
      : yKeys;

    // Collect raw rows
    const rawRows = [];
    for (const y of commentRows) {
      const rowItems = rowMap[y].sort((a, b) => a.x - b.x);
      const text = rowItems.map(i => i.str).join(' ').trim().replace(/\s+/g, ' ');
      if (isValidComment(text)) rawRows.push({ y, text });
    }

    // MERGE CONTINUATION LINES: merge rows that are part of the same paragraph
    // A new paragraph starts when: previous line ends with sentence punctuation AND y-gap is large
    const merged = [];
    let i = 0;
    while (i < rawRows.length) {
      let current = rawRows[i].text;
      // Keep merging while next line looks like a continuation of the same comment
      while (i + 1 < rawRows.length) {
        const next = rawRows[i + 1].text;
        const yGap = rawRows[i].y - rawRows[i + 1].y;
        const endsWithPunct = /[.!?]$/.test(current.trim());
        const nextStartsUpper = /^[A-Z]/.test(next.trim());
        // Merge if: small y-gap (same paragraph block, typically <25pt between lines)
        // AND either: current doesn't end with punctuation, OR next starts lowercase (continuation)
        if (yGap < 25 && (!endsWithPunct || !nextStartsUpper)) {
          current = current + ' ' + next;
          i++;
        } else {
          break;
        }
      }
      comments.push(current.trim().replace(/\s+/g, ' '));
      i++;
    }
  }

  // Deduplicate
  const unique = [...new Set(comments)];
  console.log(`[PDF] Extracted ${unique.length} student comments for AI analysis`);
  return unique;
}

// ─────────────────────────────────────────────────────────────────
// GOOGLE DRIVE LINK CONVERTER
// ─────────────────────────────────────────────────────────────────
function convertDriveLink(url) {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  return url;
}

async function fetchPDFBuffer(url) {
  const res = await axios.get(convertDriveLink(url), {
    responseType: 'arraybuffer', timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }, maxRedirects: 5
  });
  return Buffer.from(res.data);
}

// ─────────────────────────────────────────────────────────────────
// METADATA EXTRACTION
// Reads the faculty table header + data row pattern:
//   Header row: "Faculty Name | Course Code | Course Name | Semester ..."
//   Data row:   "Tanuja | Sharma | 16242202-Batch-A | Software Engineering | 4 ..."
// ─────────────────────────────────────────────────────────────────
async function extractMetaFromBuffer(buffer) {
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
    // Detect new "S.No | Name of Faculty | Code / Subject / Batch | Programme & Semester"
    // Or old "Faculty | Course Code | Course Name | Semester"
    if (rowText.includes('faculty') && (rowText.includes('code') || rowText.includes('subject')) && (rowText.includes('semester') || rowText.includes('sem') || rowText.includes('programme'))) {
      headerY = y;
      // Data row is the next substantial row below header (skip single-item rows)
      const lowerRows = yKeys.filter(k => k < y).sort((a, b) => b - a);
      for (const ky of lowerRows) {
        if (rowMap[ky].length >= 5) { // must have at least 5 items (real data row)
          dataY = ky;
          break;
        }
      }
      break;
    }
  }

  const meta = { facultyName: '', subjectCode: '', programme: '', semester: '' };

  if (!headerY || !dataY) {
    const fullText = items.map(i => i.str).join('\n');
    return extractMetaFromText(fullText);
  }

  // From debug output, the data row x positions are:
  // x~72-130:  Faculty Name (first + last name)
  // x~155-240: Course Code (e.g. "16242202-Batch-A")
  // x~259-315: Course Name (e.g. "Software Engineering") — may also be on row above
  // x~317-360: Semester (e.g. "4")
  // We use the header row to dynamically find these x boundaries

  const headerItems = rowMap[headerY];
  const dataItems = rowMap[dataY];

  // Find x of a header item matching keywords
  function headerX(kws) {
    for (const item of headerItems) {
      if (kws.some(kw => item.str.toLowerCase().includes(kw))) return item.x;
    }
    return null;
  }

  // Get sorted unique x positions from header to find column right boundaries
  const headerXs = [...new Set(headerItems.map(i => Math.round(i.x)))].sort((a, b) => a - b);
  function nextX(x) {
    const idx = headerXs.findIndex(hx => Math.abs(hx - x) < 15);
    return idx >= 0 && idx + 1 < headerXs.length ? headerXs[idx + 1] : 9999;
  }

  // Collect data items in x range across multiple rows
  function collect(x1, x2, extraYs) {
    const ys = [dataY, ...(extraYs || [])];
    const parts = [];
    ys.forEach(yk => {
      (rowMap[yk] || [])
        .filter(i => i.x >= x1 - 10 && i.x < x2 - 5)
        .forEach(i => parts.push(i.str));
    });
    return parts.join(' ').trim().replace(/\s+/g, ' ');
  }

  // Pre-compute all column x positions from header
  // From debug: Faculty=72, Course(Code)=155.9, Course(Name)=259.1, Semester=317.8, FFI=547.2
  const facultyHeaderX  = headerX(['faculty']);
  const courseHeaders   = headerItems.filter(i => i.str.toLowerCase() === 'course').sort((a,b) => a.x - b.x);
  const firstCourseX    = courseHeaders[0]?.x ?? null;   // Course Code column (~155)
  const secondCourseX   = courseHeaders[1]?.x ?? null;   // Course Name column (~259)
  const semesterHeaderX = headerX(['semester', 'sem']);   // ~317

  // Faculty Name: from "Faculty" x to first "Course" x
  if (facultyHeaderX !== null && firstCourseX !== null) {
    meta.facultyName = collect(facultyHeaderX, firstCourseX);
  }

  // Subject Code: from first "Course" x to second "Course" x
  // Only take the first alphanumeric code token (e.g. "16242202") + batch suffix
  if (firstCourseX !== null) {
    const nX = secondCourseX ?? semesterHeaderX ?? 9999;
    const raw = collect(firstCourseX, nX).trim();
    // The course code cell may contain: "16242202-Batch-A" or "16242202 Batch-A" or "16242202 Batch A"
    // Step 1: collapse all whitespace around hyphens
    const cleaned = raw.replace(/\s*-\s*/g, '-').trim();
    // Step 2: find the code — digits followed by any -word parts (including Batch-A)
    // Also handle space-separated: "16242202 Batch-A" → treat space before Batch as hyphen
    const withBatch = cleaned.replace(/(\d{5,})\s+([A-Za-z])/g, '$1-$2');
    const codeMatch = withBatch.match(/\d{5,}(?:-[A-Za-z0-9]+)*/);
    meta.subjectCode = codeMatch ? codeMatch[0] : raw.split(/[\s]+/)[0];
    console.log(`[PDF Meta] raw:"${raw}" → code:"${meta.subjectCode}"`);
  }

  // Programme (Course Name): from second "Course" x to "Semester" x
  // Also check row above dataY for multi-line course name
  if (secondCourseX !== null) {
    const nX = semesterHeaderX ?? 9999;
    const aboveYs = yKeys.filter(k => k > dataY && k <= dataY + 25);
    const aboveParts = [];
    aboveYs.forEach(yk => {
      (rowMap[yk] || []).filter(i => i.x >= secondCourseX - 10 && i.x < nX - 5).forEach(i => aboveParts.push(i.str));
    });
    const dataParts = (rowMap[dataY] || []).filter(i => i.x >= secondCourseX - 10 && i.x < nX - 5).map(i => i.str);
    meta.programme = [...aboveParts, ...dataParts].join(' ').trim().replace(/\s+/g, ' ');
  }

  // Semester: single value at "Semester" column (width ~40px)
  if (semesterHeaderX !== null) {
    const semItems = (rowMap[dataY] || []).filter(i => i.x >= semesterHeaderX - 10 && i.x < semesterHeaderX + 40);
    meta.semester = semItems.map(i => i.str).join('').trim();
  }

  // FFI Score: rightmost decimal number in the data row
  const dataRowItems = rowMap[dataY] || [];
  const ffiItem = dataRowItems.filter(i => /^\d+\.\d+$/.test(i.str)).sort((a, b) => b.x - a.x)[0];
  meta.ffiScore = ffiItem ? parseFloat(ffiItem.str) : null;

  // Response Count: Look for an integer string to the LEFT of FFI score
  const ffiX = ffiItem ? ffiItem.x : 540;
  // Search for an integer between FFI and 250px to its left (matches your screenshot layout)
  const respItem = dataRowItems.find(i => i.x < ffiX - 10 && i.x > ffiX - 250 && /^\d+$/.test(i.str));
  meta.responseCount = respItem ? parseInt(respItem.str, 10) : null;

  // GLOBAL FALLBACK Pattern Recognition
  if (meta.responseCount === null) {
     const fullText = items.map(i => i.str).join(" ");
     const m = fullText.match(/Respon[sc]e[ \t]*[:\-]?\s*(\d+)/i) || 
               fullText.match(/Resp[ \t]*[:\-]?\s*(\d+)/i) ||
               fullText.match(/Ans[ \t]*[:\-]?\s*(\d+)/i);
     if (m) meta.responseCount = parseInt(m[1], 10);
  }

  return meta;
}

function extractMetaFromText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const meta = { facultyName: '', subjectCode: '', programme: '', semester: '', responseCount: null };
  const patterns = {
    facultyName: [/faculty\s*name\s*[:\-]\s*(.+)/i, /name\s+of\s+faculty\s*[:\-]\s*(.+)/i, /faculty\s*[:\-]\s*(.+)/i, /teacher\s*[:\-]\s*(.+)/i],
    subjectCode: [/code\s*\/\s*subject\s*[:\-]\s*(.+)/i, /subject\s*code\s*[:\-]\s*([A-Z0-9\s\-]+)/i, /course\s*code\s*[:\-]\s*([A-Z0-9\s\-]+)/i, /code\s*[:\-]\s*([A-Z0-9\-]{3,15})/i],
    programme: [/programme\s*&\s*semester\s*[:\-]\s*(.+)/i, /programme\s*[:\-]\s*(.+)/i, /program\s*[:\-]\s*(.+)/i, /branch\s*[:\-]\s*(.+)/i, /department\s*[:\-]\s*(.+)/i],
    semester: [/semester\s*[:\-]\s*(\w+)/i, /sem\s*[:\-]\s*(\w+)/i, /(\d+)\s*(?:st|nd|rd|th)\s*sem/i]
  };
  const fullText = lines.join('\n');
  for (const [field, regexList] of Object.entries(patterns)) {
    for (const regex of regexList) {
      const match = fullText.match(regex);
      if (match) {
        const value = (match[1] || match[0] || '').trim().replace(/\s+/g, ' ');
        if (value.length > 1 && value.length < 80) { meta[field] = value; break; }
      }
    }
  }
  if (!meta.facultyName) {
    for (const line of lines) {
      if (/^(dr|prof|mr|mrs|ms)\.?\s+\w+/i.test(line) && line.length < 60) {
        meta.facultyName = line.trim(); break;
      }
    }
  }
  return meta;
}

// ─────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────
async function analyzePDF(pdfLink) {
  const buffer = await fetchPDFBuffer(pdfLink);
  return analyzePDFBuffer(buffer);
}

/**
 * Calculate accurate percentages from raw student comments.
 * Counts exact keyword occurrences across ALL comments (not just classified ones).
 * Returns: { "Excellent": 10, "Very Good": 25, "Good": 65 } (percentages)
 */
function calculateCommentPercentages(allComments) {
  if (!allComments || allComments.length === 0) return {};

  const KEYWORDS = {
    'Excellent': ['excellent', 'outstanding', 'superb', 'brilliant', 'best', 'besttttt', 'bestt', 'excellent teacher', 'excellent mam', 'excellent sir'],
    'Very Good': ['very good', 'very well', 'very nice', 'very helpful', 'very great'],
    'Good':      ['good', 'great', 'nice', 'well done', 'satisfactory', 'good teacher', 'good mam', 'good sir', 'overall good', 'nicely'],
  };

  const counts = { 'Excellent': 0, 'Very Good': 0, 'Good': 0 };

  allComments.forEach(comment => {
    const lower = comment.toLowerCase().trim();
    // Check in priority order: Excellent > Very Good > Good
    for (const [category, keywords] of Object.entries(KEYWORDS)) {
      if (keywords.some(kw => {
        // Match: exact, starts with, ends with, or contains as whole word
        return lower === kw
          || lower === kw + '.'
          || lower.startsWith(kw + ' ')
          || lower.endsWith(' ' + kw)
          || lower.includes(' ' + kw + ' ')
          || lower.includes(' ' + kw + '.')
          // Also match if comment IS just this keyword (case insensitive)
          || lower.replace(/[^a-z\s]/g, '').trim() === kw;
      })) {
        counts[category]++;
        break;
      }
    }
  });

  const total = allComments.length; // percentage of ALL comments, not just matched
  const result = {};
  for (const [label, count] of Object.entries(counts)) {
    if (count > 0) {
      result[label] = Math.round((count / total) * 100);
    }
  }
  return result;
}

async function analyzePDFBuffer(buffer) {
  const { analyzeCommentsWithAI } = require('./aiAnalyzer');

  // Run meta extraction and full text extraction in parallel
  const [meta, allComments] = await Promise.all([
    extractMetaFromBuffer(buffer),
    extractAllStudentComments(buffer)
  ]);

  let appreciation = [];
  let commentsNeedingAttention = [];

  if (allComments.length > 0) {
    try {
      const aiResult = await analyzeCommentsWithAI(allComments);
      appreciation = aiResult.appreciation;
      commentsNeedingAttention = aiResult.commentsNeedingAttention;
    } catch (aiErr) {
      const highlights = await extractHighlightedText(buffer);
      appreciation = highlights.appreciation;
      commentsNeedingAttention = highlights.commentsNeedingAttention;
    }
  } else {
    const highlights = await extractHighlightedText(buffer);
    appreciation = highlights.appreciation;
    commentsNeedingAttention = highlights.commentsNeedingAttention;
  }

  const commentPercentages = calculateCommentPercentages(allComments);

  return {
    appreciation,
    commentsNeedingAttention,
    appreciationCount: appreciation.length,
    attentionCount: commentsNeedingAttention.length,
    commentPercentages,
    meta, // Include full meta object
    ffiScore: meta.ffiScore ?? null,
    responseCount: meta.responseCount ?? null,
    analyzedAt: new Date()
  };
}

async function extractMetaFromPDF(buffer) {
  try { return await extractMetaFromBuffer(buffer); }
  catch { return { facultyName: '', subjectCode: '', programme: '', semester: '', ffiScore: null }; }
}

module.exports = { analyzePDF, analyzePDFBuffer, extractMetaFromPDF, convertDriveLink };
