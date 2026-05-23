/**
 * AI Comment Analyzer using HuggingFace Transformers (local, no API key needed)
 * Model: distilbert-base-uncased-finetuned-sst-2-english
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

/**
 * Analyze all comments — batch them to avoid overloading the model
 */
async function analyzeCommentsWithAI(rawComments) {
  if (!rawComments || rawComments.length === 0) {
    return { appreciation: [], commentsNeedingAttention: [] };
  }

  const appreciation = [];
  const commentsNeedingAttention = [];

  // PRE-FILTER: Short keyword-only comments (≤4 words) that are clearly positive
  // go directly to appreciation without AI — avoids misclassification of fragments
  const CLEAR_POSITIVE = ['good', 'great', 'nice', 'excellent', 'outstanding', 'superb',
    'very good', 'very nice', 'very helpful', 'best', 'brilliant', 'satisfactory',
    'nicely', 'overall good', 'good teacher', 'excellent teacher', 'nice mam',
    'good mam', 'good sir', 'excellent mam', 'excellent sir', 'besttttt'];

  const CLEAR_NEGATIVE = ['no', 'nil', 'na', 'n/a', 'none', 'nothing', 'not great',
    'not good', 'poor', 'bad', 'worst'];

  const toClassify = [];
  const preClassified = new Map(); // index → 'positive' | 'negative'

  rawComments.forEach((comment, idx) => {
    const lower = comment.toLowerCase().trim().replace(/[^a-z\s]/g, '').trim();
    const wordCount = comment.trim().split(/\s+/).length;

    if (CLEAR_POSITIVE.some(kw => lower === kw || lower === kw + 's')) {
      preClassified.set(idx, 'positive');
    } else if (CLEAR_NEGATIVE.some(kw => lower === kw)) {
      preClassified.set(idx, 'negative');
    } else if (wordCount > 8) {
      // Long comments (>8 words) — send to AI for proper classification
      toClassify.push({ idx, comment });
    } else {
      // Medium comments — send to AI
      toClassify.push({ idx, comment });
    }
  });

  // Apply pre-classified
  rawComments.forEach((comment, idx) => {
    if (preClassified.has(idx)) {
      if (preClassified.get(idx) === 'positive') appreciation.push(comment.trim());
      else commentsNeedingAttention.push(comment.trim());
    }
  });

  // AI classify the rest
  if (toClassify.length > 0) {
    try {
      const classifier = await getSentimentPipeline();
      const BATCH_SIZE = 20; // Increased batch size

      for (let i = 0; i < toClassify.length; i += BATCH_SIZE) {
        const batch = toClassify.slice(i, i + BATCH_SIZE);

        // Process the entire batch in parallel
        await Promise.all(batch.map(async ({ comment }) => {
          try {
            const result = await classifier(comment.trim(), { truncation: true });
            if (result[0].label === 'POSITIVE') {
              appreciation.push(comment.trim());
            } else {
              commentsNeedingAttention.push(comment.trim());
            }
          } catch {
            commentsNeedingAttention.push(comment.trim());
          }
        }));
      }
    } catch (err) {
      console.warn('[AI] Classification failed, using fallback:', err.message);
      toClassify.forEach(({ comment }) => {
        if (comment?.trim()) commentsNeedingAttention.push(comment.trim());
      });
    }
  }

  return { appreciation, commentsNeedingAttention };
}

async function testGeminiConnection() {
  try {
    const classifier = await getSentimentPipeline();
    const result = await classifier('The teacher is excellent');
    return {
      ok: true,
      response: `HuggingFace AI working — "${result[0].label}" (${(result[0].score * 100).toFixed(1)}% confidence)`,
      engine: 'HuggingFace (local, no API key needed)'
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { analyzeCommentsWithAI, testGeminiConnection };
