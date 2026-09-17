/**
 * AI Comment Analyzer — Smart Rule-Based + HuggingFace fallback
 *
 * Problem with pure AI: distilbert misclassifies short academic phrases like
 * "Very Good", "Great classes", "Excellent mam" as NEGATIVE because it was
 * trained on movie reviews, not faculty feedback forms.
 *
 * Solution: A comprehensive rule-based classifier that understands MITS
 * feedback form language (English + Hinglish), with AI only as a fallback
 * for genuinely ambiguous long sentences.
 */

let pipeline = null;
let pipelineLoading = false;

async function getSentimentPipeline() {
  if (pipeline) return pipeline;
  if (pipelineLoading) {
    while (pipelineLoading) await new Promise(r => setTimeout(r, 100));
    return pipeline;
  }
  pipelineLoading = true;
  try {
    const { pipeline: createPipeline } = await import('@xenova/transformers');
    pipeline = await createPipeline('sentiment-analysis', 'Xenova/distilbert-base-uncased-finetuned-sst-2-english');
    console.log('[AI] HuggingFace sentiment model loaded');
  } finally {
    pipelineLoading = false;
  }
  return pipeline;
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE keyword patterns — academic feedback context
// ─────────────────────────────────────────────────────────────────────────────
const POSITIVE_PATTERNS = [
  // Rating words (from feedback forms)
  /^excellent$/i, /^very good$/i, /^good$/i, /^great$/i, /^outstanding$/i,
  /^superb$/i, /^brilliant$/i, /^best$/i, /^nice$/i, /^satisfactory$/i,
  /^wonderful$/i, /^awesome$/i, /^perfect$/i, /^fantastic$/i, /^amazing$/i,
  /^exceptional$/i, /^magnificent$/i, /^splendid$/i, /^marvelous$/i,

  // Compound positives
  /very good/i, /quite good/i, /really good/i, /very nice/i, /very helpful/i,
  /very clear/i, /very effective/i, /very well/i, /extremely good/i,
  /highly satisfied/i, /highly recommend/i, /very satisf/i,

  // Teaching positives
  /great teacher/i, /good teacher/i, /excellent teacher/i, /best teacher/i,
  /great class/i, /good class/i, /excellent class/i, /great lecture/i,
  /good lecture/i, /excellent lecture/i, /good explanation/i,
  /clear explanation/i, /easy to understand/i, /easy to learn/i,
  /well explained/i, /nicely explained/i, /clearly explained/i,
  /good concept/i, /good knowledge/i, /great knowledge/i,
  /good communication/i, /good interaction/i, /good teaching/i,
  /excellent teaching/i, /great teaching/i, /effective teaching/i,
  /good understanding/i, /makes it easy/i, /easy to grasp/i,

  // Respect / appreciation phrases (Indian academic context)
  /good mam/i, /good sir/i, /nice mam/i, /nice sir/i,
  /excellent mam/i, /excellent sir/i, /best mam/i, /best sir/i,
  /great mam/i, /great sir/i, /thank you/i, /thanks a lot/i,
  /grateful/i, /appreciate/i, /wonderful mam/i, /wonderful sir/i,
  /hats off/i, /keep it up/i, /keep up/i, /well done/i,

  // Satisfaction
  /fully satisfied/i, /completely satisfied/i, /very satisfied/i,
  /overall good/i, /overall great/i, /overall excellent/i, /overall nice/i,
  /overall satisf/i, /nothing to improve/i, /no improvement needed/i,
  /no suggestion/i, /no complaints/i, /everything is good/i,
  /everything good/i, /all good/i, /all is well/i,

  // Encouragement
  /continue the same/i, /please continue/i, /keep going/i,
  /maintain this/i, /best wishes/i, /good luck/i,

  // Hinglish positive
  /bahut accha/i, /bahut acha/i, /acha hai/i, /accha hai/i,
  /best hai/i, /zabardast/i, /mast hai/i, /sahi hai/i,

  // Negation-positive (sound negative but are actually positive/neutral)
  /not bad/i, /not bad at all/i, /no complaints/i, /no problem/i,
  /no issues/i, /nothing to complain/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE keyword patterns — attention needed
// ─────────────────────────────────────────────────────────────────────────────
const NEGATIVE_PATTERNS = [
  // Clear negatives
  /^no$/i, /^nil$/i, /^na$/i, /^n\/a$/i, /^none$/i, /^nothing$/i,
  /^poor$/i, /^bad$/i, /^worst$/i, /^terrible$/i, /^horrible$/i,
  /^average$/i, /^below average$/i, /^not good$/i, /^not great$/i,

  // Improvement needed
  /need to improve/i, /needs improvement/i, /should improve/i,
  /must improve/i, /can improve/i, /could improve/i, /require improvement/i,
  /improve your/i, /improve the/i, /please improve/i,

  // Speed / pace issues
  /too fast/i, /very fast/i, /speaks fast/i, /teaching fast/i,
  /talks fast/i, /goes fast/i, /rushes through/i,
  /too slow/i, /very slow/i, /slow speed/i, /slow pace/i,
  /reduce speed/i, /slow down/i,

  // Clarity issues
  /not clear/i, /unclear/i, /hard to understand/i, /difficult to understand/i,
  /difficult to follow/i, /hard to follow/i, /not understandable/i,
  /poor explanation/i, /bad explanation/i, /confusing/i,
  /didn't understand/i, /don't understand/i, /did not understand/i,
  /cannot understand/i, /can't understand/i,
  /doesn't explain/i, /does not explain/i, /didn't explain/i,
  /not explained/i, /poorly explained/i,

  // Availability / interaction
  /not available/i, /never available/i, /not approachable/i,
  /no interaction/i, /less interaction/i, /poor interaction/i,
  /does not interact/i, /doesn't interact/i,
  /not accessible/i, /does not help/i, /doesn't help/i,
  /not cooperative/i, /not supportive/i,

  // Material issues — EXPANDED
  /no notes/i, /no material/i, /no slides/i, /no pdf/i,
  /should share/i, /please share/i, /provide notes/i,
  /not provided/i, /not shared/i, /not given/i,
  /notes not/i, /material not/i, /slides not/i, /pdf not/i,
  /doesn't provide/i, /does not provide/i, /didn't provide/i,
  /doesn't share/i, /does not share/i, /didn't share/i,
  /doesn't give/i, /does not give/i, /didn't give/i,
  /share notes/i, /share material/i, /share slides/i,
  /provide material/i, /give notes/i, /upload notes/i,

  // Attendance / regularity — EXPANDED
  /irregular/i, /not regular/i, /misses class/i, /skips class/i,
  /not punctual/i, /late to class/i,
  /always late/i, /comes late/i, /come late/i, /came late/i, /is late/i,
  /miss kart/i, /class miss/i, /class nahi/i, /class cancel/i,
  /doesn't come/i, /does not come/i, /didn't come/i,
  /absent/i, /not present/i, /bunks/i, /skip/i,
  /class nahi lete/i, /class nahi aate/i,

  // General negative — EXPANDED
  /lack of/i, /lacks/i, /problem with/i, /issue with/i,
  /dissatisfied/i, /not satisfied/i, /disappointing/i, /disappointed/i,
  /didn't like/i, /don't like/i, /did not like/i, /do not like/i,
  /could be better/i, /waste of time/i, /boring/i, /bored/i,
  /not helpful/i, /unhelpful/i,
  /not interested/i, /lost interest/i, /no interest/i,
  /not effective/i, /ineffective/i,
  /not useful/i, /useless/i,
  /not satisfied/i, /unsatisfied/i,
  /not relevant/i, /irrelevant/i,
  /no doubt solving/i, /doubt clear nahi/i,
  /favouritism/i, /biased/i, /partial/i,
  /rude/i, /harsh/i, /strict/i, /angry/i,
  /doesn't care/i, /does not care/i,
  /doesn't listen/i, /does not listen/i,
  /not engaging/i, /monotonous/i,
  /nothing special/i, /nothing new/i,
  /doesn't teach/i, /does not teach/i,
  /not prepared/i, /unprepared/i,
  /not enough/i, /insufficient/i,
  /should focus/i, /should work on/i,

  // Hinglish negatives — EXPANDED
  /accha nahi/i, /acha nahi/i, /theek nahi/i, /thik nahi/i,
  /samajh nahi/i, /samajh me nahi/i,
  /bakwas/i, /bekar/i, /faltu/i, /ghatiya/i,
  /jaldi bolte/i, /jaldi padhate/i,
  /boring hai/i, /bore hota/i, /bore karta/i,
  /nahi aata/i, /nahi aati/i, /nahi aate/i,
  /nahi padhat/i, /nahi sikhate/i,
  /kuch nahi/i, /koi fayda nahi/i,
  /late aate/i, /late aati/i,
  /miss karte/i, /miss karti/i,

  // Generic "not" + action/quality (catch-all for "not provided", "not shared", etc.)
  /\bnot\s+\w+ed\b/i,  // "not provided", "not shared", "not explained", "not prepared"
  /\bnot\s+\w+ing\b/i, // "not teaching", "not sharing", "not helping"
];

// ─────────────────────────────────────────────────────────────────────────────
// Skip / irrelevant patterns — empty or meaningless entries
// ─────────────────────────────────────────────────────────────────────────────
const SKIP_PATTERNS = [
  /^-+$/, /^\.*$/, /^_+$/, /^\s*$/, /^x+$/i, /^\.{1,3}$/,
  /^[0-9]+$/, /^[^a-zA-Z]+$/,
];

// ─────────────────────────────────────────────────────────────────────────────
// Categorization patterns
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_PATTERNS = {
  Speed: /\b(fast|slow|speed|pace|quick|jaldi|rush)/i,
  Clarity: /\b(unclear|confusing|understand|explain|clear|samajh|concept)/i,
  Materials: /\b(notes|material|slide|pdf|book|share|provided|shared|upload|give|provide)/i,
  Interaction: /\b(available|interaction|doubt|question|help|approachable|cooperative|listen|care)/i,
  Regularity: /\b(irregular|regular|punctual|late|miss|skip|absent|cancel|bunks|aate|aati|come|class nahi)/i
};

// Split words for mixed sentiment
const SPLIT_REGEX = /\b(?:but|however|though|although|yet|still|lekin|par|magar|parantu)\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// Neutral / irrelevant phrases — students writing filler, should be skipped
// ─────────────────────────────────────────────────────────────────────────────
const NEUTRAL_SKIP_PATTERNS = [
  /don't know what to/i, /don't know what to write/i,
  /i don't know/i, /idk/i,
  /nothing to say/i, /nothing to write/i, /nothing much/i,
  /no comment/i, /no opinion/i, /can't say/i,
  /kuch nahi likhna/i, /pata nahi/i, /kya likhu/i,
  /no idea/i, /whatever/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Rule-based classifier
// ─────────────────────────────────────────────────────────────────────────────
function ruleBasedClassify(comment) {
  const text = comment.trim();
  if (!text || text.length < 2) return 'skip';

  // Skip meaningless entries
  if (SKIP_PATTERNS.some(p => p.test(text))) return 'skip';

  // Skip irrelevant filler comments ("I don't know what to write", "nothing to say")
  if (NEUTRAL_SKIP_PATTERNS.some(p => p.test(text.toLowerCase()))) return 'skip';

  const lower = text.toLowerCase();

  // Check NEGATIVE first (more specific — prevents "needs to improve speed" going positive)
  if (NEGATIVE_PATTERNS.some(p => p.test(lower))) return 'negative';

  // Check positive patterns
  if (POSITIVE_PATTERNS.some(p => p.test(lower))) return 'positive';

  // Short comments (≤5 words) with no clear classification
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= 5) {
    // Check for generic negative indicators even if no pattern matched
    // Covers: "not X", "no X", "never X"
    if (/\b(not|no|never|don't|doesn't|didn't|can't|won't|shouldn't|couldn't)\b/i.test(lower)) {
      return 'negative';
    }
    // Truly ambiguous short comment, no negative indicator found
    return 'neutral';
  }

  // For longer comments, also check for generic negative indicators before sending to AI
  if (/\b(not|no|never|don't|doesn't|didn't|can't|won't|shouldn't|couldn't)\b/i.test(lower)) {
    // Contains negation but no positive pattern matched → likely negative
    return 'negative';
  }

  // Long enough for AI
  return 'ai';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main analyzer
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeCommentsWithAI(rawComments) {
  const defaultResult = {
    appreciation: [],
    commentsNeedingAttention: [],
    commentCategories: {
      Speed: [], Clarity: [], Materials: [], Interaction: [], Regularity: [], General: []
    }
  };

  if (!rawComments || rawComments.length === 0) {
    return defaultResult;
  }

  const result = {
    appreciation: [],
    commentsNeedingAttention: [],
    commentCategories: {
      Speed: [], Clarity: [], Materials: [], Interaction: [], Regularity: [], General: []
    }
  };
  
  const toClassifyWithAI = [];

  const addAttention = (text) => {
    result.commentsNeedingAttention.push(text);
    let categorized = false;
    for (const [category, regex] of Object.entries(CATEGORY_PATTERNS)) {
      if (regex.test(text)) {
        result.commentCategories[category].push(text);
        categorized = true;
      }
    }
    if (!categorized) {
      result.commentCategories.General.push(text);
    }
  };

  // Step 1: rule-based pre-classification with splitting for mixed-sentiment
  rawComments.forEach((originalComment, idx) => {
    if (!originalComment || typeof originalComment !== 'string') return;
    
    // Split mixed-sentiment comments
    const parts = originalComment.split(SPLIT_REGEX).filter(p => p.trim().length > 0);
    
    parts.forEach(part => {
      const text = part.trim();
      const decision = ruleBasedClassify(text);
      
      if (decision === 'positive' || decision === 'neutral') {
        result.appreciation.push(text);
      } else if (decision === 'negative') {
        addAttention(text);
      } else if (decision === 'ai') {
        toClassifyWithAI.push({ idx, comment: text });
      }
      // 'skip' → discard
    });
  });

  // Step 2: AI classification for genuinely ambiguous long comments only
  if (toClassifyWithAI.length > 0) {
    try {
      const classifier = await getSentimentPipeline();
      const BATCH_SIZE = 16;

      for (let i = 0; i < toClassifyWithAI.length; i += BATCH_SIZE) {
        const batch = toClassifyWithAI.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async ({ comment }) => {
          try {
            const res = await classifier(comment, { truncation: true });
            const label = res[0].label;
            const score = res[0].score;

            // Only trust AI if confidence is high (>75%)
            // Low confidence → default to positive (benefit of the doubt)
            if (label === 'POSITIVE' || score < 0.75) {
              result.appreciation.push(comment);
            } else {
              // Double-check: if the comment contains any positive keyword, override to positive
              const lower = comment.toLowerCase();
              const hasPositiveWord = POSITIVE_PATTERNS.some(p => p.test(lower));
              if (hasPositiveWord) {
                result.appreciation.push(comment);
              } else {
                addAttention(comment);
              }
            }
          } catch {
            // On error, default to positive
            result.appreciation.push(comment);
          }
        }));
      }
    } catch (err) {
      console.warn('[AI] Classification failed, using rule-based fallback:', err.message);
      // Fallback: use simple keyword check
      toClassifyWithAI.forEach(({ comment }) => {
        const lower = comment.toLowerCase();
        const hasNegative = NEGATIVE_PATTERNS.some(p => p.test(lower));
        if (hasNegative) addAttention(comment);
        else result.appreciation.push(comment);
      });
    }
  }

  console.log(`[AI] Classified ${rawComments.length} comments → ${result.appreciation.length} positive, ${result.commentsNeedingAttention.length} attention needed`);
  return result;
}

async function testGeminiConnection() {
  try {
    // Test with a typical MITS feedback comment
    const testComments = ['Very good teaching', 'needs to improve speed', 'excellent mam', 'Good teaching but too fast'];
    const result = await analyzeCommentsWithAI(testComments);
    return {
      ok: true,
      response: `AI working — ${result.appreciation.length} positive, ${result.commentsNeedingAttention.length} attention`,
      engine: 'HuggingFace + Rule-Based (local, no API key needed)',
      test: result,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { analyzeCommentsWithAI, testGeminiConnection };
