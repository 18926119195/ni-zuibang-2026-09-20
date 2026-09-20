/**
 * 基于词表拓扑链的召回引擎（两步粗筛 + 精打分架构）
 *
 * 流程：
 * 1. 粗筛（LLM 1 轮）：快速判断"是否相关"，每批输入【【N】】词语，只回【【N】】列表或 NONE
 * 2. 精打（LLM 2 轮）：只对粗筛 YES 的词打分，每批输入【【N】】词语，只回 JSON 数组
 * 3. 高分词 → 构建拓扑链 → 映射 bookKey → ChunkKey 去重 → 召回原文
 *
 * LLM 调用统一走 src/core/llmClient.js（DeepSeek，deepseek-chat，thinking 强制关闭）。
 *
 * 用法：
 *   node recall-nouns-llm.js                      # 所有问题
 *   node recall-nouns-llm.js Z1-Q1 Z1-Q2           # 指定问题ID
 *   NOUN_BATCH_SIZE=500 node recall-nouns-llm.js   # 粗筛批次大小（默认500）
 */

import fs from 'fs';
import path from 'path';
import { callLLM, LLM_BASE_URL, LLM_MODEL } from './src/core/llmClient.js';
import { atomSearchText, isRetrievableAtom } from './src/core/pureTextTable.js';

// ============ 配置（环境变量覆盖）============
const DOCUVERSE_PATH = process.env.DOCUVERSE_PATH || 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const NOUN_INDEX_PATH = process.env.NOUN_INDEX_PATH || path.join(process.cwd(), 'final-noun-index.json');
const QUESTIONS_PATH = process.env.QUESTIONS_PATH || path.join(process.cwd(), 'test-questions.json');
const OUTPUT_PATH = process.env.OUTPUT_PATH || path.join(process.cwd(), 'noun-recall-results.json');

const CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '8', 10);
const COARSE_BATCH_SIZE = parseInt(process.env.NOUN_BATCH_SIZE || '500', 10);
const SCORE_BATCH_SIZE = parseInt(process.env.SCORE_BATCH_SIZE || '80', 10);
const TOP_N = parseInt(process.env.TOP_N || '100', 10);
const TOPOLOGY_WINDOW = parseInt(process.env.TOPOLOGY_WINDOW || '5', 10);
const QUESTION_IDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (process.env.QUESTION_IDS || '').split(',').filter(Boolean);

console.log(`LLM: ${LLM_BASE_URL} model=${LLM_MODEL} thinking=disabled`);

// ============ 加载数据 ============
console.log('加载数据...');
const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
const nounIndex = JSON.parse(fs.readFileSync(NOUN_INDEX_PATH, 'utf-8'));
const questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8'));

// 构建 chunk 表（不再拼接全局 fullText，也不计算全局偏移量）
const chunkEntries = [];
for (const chunk of docuverse.bookIndex.chunks) {
  if (!isRetrievableAtom(chunk)) continue;
  const text = atomSearchText(chunk).trim();
  if (!text || text.length < 8) continue;
  chunkEntries.push({
    chunkKey: chunk.key,
    page: chunk.page,
    text,
  });
}
// chunkKey -> entry 的直查表，取代原来的"全局偏移二分查找"
const chunkByKey = new Map(chunkEntries.map((e) => [e.chunkKey, e]));
console.log(`  chunk 数: ${chunkEntries.length}（无全局拼接）`);
console.log(`  名词数: ${nounIndex.nouns.length}, 问题数: ${questions.length}`);

// ============ 辅助函数：isRetrievableAtom / atomSearchText 已提取到 src/core/pureTextTable.js ============
// （原来这里的本地副本对 note 清洗规则不全，与其他脚本存在细微差异，改用共享模块后消除该分裂）

// ============ Prompt 构建（机器符号，不含偏移量） ============
function buildCoarsePrompt(question, batchWords) {
  const list = batchWords.map((w, i) => `【【${i + 1}】】${w}`).join('\n');
  return `问题: ${question}

从下列名词中，选出所有对回答这个问题可能有帮助的词。只回答相关词的机器符号（用 | 分隔），例如：|【【1】|【【5】|【【17】|
如果没有任何相关词，回答：NONE

词语列表：
${list}

相关词编号：`;
}

function buildScorePrompt(question, yesNounSurfaces) {
  const list = yesNounSurfaces.map((w, i) => `【【${i + 1}】】${w}`).join('\n');
  return `问题: ${question}

以下是你选中的相关词，请按重要程度打分（1-100）：
  1-30   弱相关：领域相关但非核心，仅提及
  31-60  中等相关：对答案有一定贡献
  61-80  强相关：重要概念，显著影响答案质量
  81-100 核心概念：没有它就无法准确回答

词语列表：
${list}

只输出 JSON 数组（用【【N】】引用词语），只包含你选中的词，例如：
【【{"i":"【【1】】","score":95},{"i":"【【3】】","score":72}】】

如果这批里没有任何相关词，输出【【】】。`;
}

// ============ 解析函数（容错，宽松匹配） ============
function parseCoarseResult(rawText, batchSize) {
  if (!rawText || typeof rawText !== 'string') return [];
  const text = rawText.trim();
  if (/^none$/i.test(text)) return [];
  const indices = [];
  for (const m of text.matchAll(/【+(\d+)】+/g)) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < batchSize) indices.push(idx);
  }
  return [...new Set(indices)];
}

function parseScoreResult(rawText, batchSize) {
  if (!rawText || typeof rawText !== 'string') return [];
  const text = rawText.trim();
  if (/^【【\s*】\s*】$/.test(text)) return [];

  const indices = [];
  for (const m of text.matchAll(/【【(\d+)】】/g)) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < batchSize) indices.push(idx);
  }

  const allNumbers = [];
  for (const m of text.matchAll(/(?<![【\d])(\d{1,3})(?!\d|】)/g)) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 100) allNumbers.push(n);
  }

  const scoreMap = new Map();
  const minLen = Math.min(indices.length, allNumbers.length);
  for (let i = 0; i < minLen; i++) {
    const idx = indices[i];
    const score = allNumbers[i];
    if (!scoreMap.has(idx) || scoreMap.get(idx) < score) scoreMap.set(idx, score);
  }
  return [...scoreMap.entries()].map(([index, score]) => ({ index, score }));
}

// ============ 拓扑链召回 ============
// 关键改动：offsets 现在自带 chunkKey + 局部 start/end，直接用 Map 查 chunk，
// 不再需要二分查找和"全局位移 -> 局部位移"换算，也不会跨 chunk 边界取邻居词。
function buildNounTopology(nounId) {
  const nounEntry = nounIndex.nouns.find((n) => n.id === nounId);
  if (!nounEntry) return [];
  const results = [];
  for (const { chunkKey, start, end } of nounEntry.offsets) {
    const entry = chunkByKey.get(chunkKey);
    if (!entry) continue;
    // start/end 已经是该 chunk 内的局部位移，无需再减 startOffset
    const before = entry.text.slice(Math.max(0, start - TOPOLOGY_WINDOW * 12), start);
    const after = entry.text.slice(end, Math.min(entry.text.length, end + TOPOLOGY_WINDOW * 12));
    const beforeWords = before.split(/[\s\n.,;:!?]+/).filter((w) => w.length > 1).slice(-TOPOLOGY_WINDOW);
    const afterWords = after.split(/[\s\n.,;:!?]+/).filter((w) => w.length > 1).slice(0, TOPOLOGY_WINDOW);
    results.push({
      chunkKey: entry.chunkKey,
      page: entry.page,
      offset: start,
      neighbors: [...new Set([...beforeWords, ...afterWords])],
    });
  }
  return results;
}

function getTopologyBookKeys(nounId) {
  const chains = buildNounTopology(nounId);
  const bookKeys = new Set();
  for (const c of chains) if (c.chunkKey) bookKeys.add(c.chunkKey);
  return { chains, bookKeys: [...bookKeys] };
}

function recallByBookKey(chunkKey) {
  const entry = chunkByKey.get(chunkKey);
  return entry ? entry.text : null;
}

// ============ 主流程 ============
async function main() {
  const qList = questions.filter((q) => !QUESTION_IDS.length || QUESTION_IDS.includes(q.id));
  console.log(`========== 拓扑链召回引擎（两步架构）==========`);
  console.log(`全量名词: ${nounIndex.nouns.length}, 问题数: ${qList.length}`);
  console.log(`粗筛批次: ${COARSE_BATCH_SIZE}, 精打批次: ${SCORE_BATCH_SIZE}, 并发: ${CONCURRENCY}, TOP召回: ${TOP_N}\n`);

  const allResults = [];

  for (const q of qList) {
    console.log(`\n--- [${q.id}] ${q.question} ---`);
    const t0 = Date.now();

    // ---- 第一阶段：粗筛 ----
    const coarseBatches = [];
    for (let i = 0; i < nounIndex.nouns.length; i += COARSE_BATCH_SIZE) {
      coarseBatches.push({ startIdx: i, batchNouns: nounIndex.nouns.slice(i, i + COARSE_BATCH_SIZE) });
    }

    const coarseYes = new Map();
    let coarsePromptTokens = 0, coarseCompletionTokens = 0, coarseFailedBatches = 0, coarseTruncated = 0;

    let batchIdx = 0;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (true) {
          const myIdx = batchIdx++;
          if (myIdx >= coarseBatches.length) break;
          const b = coarseBatches[myIdx];
          const surfaces = b.batchNouns.map((n) => n.surface);
          const prompt = buildCoarsePrompt(q.question, surfaces);
          const res = await callLLM(prompt, { maxTokens: 1024 });
          if (res?.usage) {
            coarsePromptTokens += res.usage.prompt_tokens || 0;
            coarseCompletionTokens += res.usage.completion_tokens || 0;
          }
          if (res?.truncated) coarseTruncated++;
          if (!res) coarseFailedBatches++;
          const yesIndices = parseCoarseResult(res?.text || '', b.batchNouns.length);
          for (const localIdx of yesIndices) coarseYes.set(b.startIdx + localIdx, true);
          process.stdout.write(`\r  粗筛: ${coarseYes.size} 个 YES / ${nounIndex.nouns.length}, 批次 ${myIdx + 1}/${coarseBatches.length}          `);
        }
      })
    );

    console.log(`\n  粗筛完成: ${coarseYes.size}/${nounIndex.nouns.length} 个相关词 (失败: ${coarseFailedBatches}/${coarseBatches.length})`);
    console.log(`  粗筛 tokens: prompt=${coarsePromptTokens} completion=${coarseCompletionTokens}`);
    if (coarseTruncated > 0) console.log(`  ⚠️  粗筛截断: ${coarseTruncated}/${coarseBatches.length} 批次`);

    // ---- 第二阶段：精打（仅粗筛 YES） ----
    const yesEntries = [...coarseYes.keys()].map((globalIdx) => nounIndex.nouns[globalIdx]);
    const scored = new Map();
    let scorePromptTokens = 0, scoreCompletionTokens = 0;

    if (yesEntries.length === 0) {
      console.log('  粗筛无 YES 词，跳过精打');
    } else {
      const scoreBatches = [];
      for (let i = 0; i < yesEntries.length; i += SCORE_BATCH_SIZE) {
        scoreBatches.push({ startIdx: i, batchEntries: yesEntries.slice(i, i + SCORE_BATCH_SIZE) });
      }

      let scoreBatchIdx = 0, scoreTruncated = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          while (true) {
            const myIdx = scoreBatchIdx++;
            if (myIdx >= scoreBatches.length) break;
            const b = scoreBatches[myIdx];
            const surfaces = b.batchEntries.map((e) => e.surface);
            const prompt = buildScorePrompt(q.question, surfaces);
            const res = await callLLM(prompt, { maxTokens: 2500 });
            if (res?.usage) {
              scorePromptTokens += res.usage.prompt_tokens || 0;
              scoreCompletionTokens += res.usage.completion_tokens || 0;
            }
            if (res?.truncated) scoreTruncated++;
            const scoredInBatch = parseScoreResult(res?.text || '', b.batchEntries.length);
            for (const { index, score } of scoredInBatch) {
              const entry = b.batchEntries[index];
              if (entry) scored.set(entry.id, score);
            }
            process.stdout.write(`\r  精打: ${scored.size}/${yesEntries.length} 个已打分, 批次 ${myIdx + 1}/${scoreBatches.length}          `);
          }
        })
      );

      console.log(`\n  精打完成: ${scored.size}/${yesEntries.length} 个已打分`);
      console.log(`  精打 tokens: prompt=${scorePromptTokens} completion=${scoreCompletionTokens}`);
      if (scoreTruncated > 0) console.log(`  ⚠️  精打截断: ${scoreTruncated}/${scoreBatches.length} 批次`);
    }

    // ---- 排序 ----
    const scoredList = [...scored.entries()]
      .map(([nounId, score]) => {
        const n = nounIndex.nouns.find((x) => x.id === nounId);
        return n ? { id: n.id, surface: n.surface, df: n.offsets.length, score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const lostCount = yesEntries.length - scored.size;
    if (lostCount > 0) {
      console.log(`  ⚠️  精打解析丢失: ${lostCount}/${yesEntries.length} 个词 (${((lostCount / yesEntries.length) * 100).toFixed(1)}%)`);
    }

    const totalPromptTokens = coarsePromptTokens + scorePromptTokens;
    const totalCompletionTokens = coarseCompletionTokens + scoreCompletionTokens;

    console.log(`  Top 10: ${scoredList.slice(0, 10).map((s) => `${s.surface}(${s.score})`).join(', ')}`);

    // ---- 拓扑链 + ChunkKey Set 去重 + 召回 ----
    const TOP_RECALL = Math.min(TOP_N, scoredList.length);
    const recallItems = [];
    const recalledBookKeys = new Set(); // Set 自动去重（35.2% 重复率优化点）

    for (let i = 0; i < TOP_RECALL; i++) {
      const item = scoredList[i];
      const { chains, bookKeys } = getTopologyBookKeys(item.id);
      for (const bk of bookKeys) recalledBookKeys.add(bk);
      recallItems.push({
        rank: i + 1,
        id: item.id,
        surface: item.surface,
        score: item.score,
        df: item.df,
        bookKeys,
        chainCount: chains.length,
        chainSample: chains.slice(0, 3).map((c) => ({ page: c.page, neighbors: c.neighbors })),
      });
    }

    const lowItems = scoredList.slice(TOP_RECALL).map((item) => {
      const { chains } = getTopologyBookKeys(item.id);
      return {
        id: item.id,
        surface: item.surface,
        score: item.score,
        df: item.df,
        chainCount: chains.length,
        chainSample: chains.slice(0, 2).map((c) => ({ page: c.page, neighbors: c.neighbors })),
      };
    });

    const recalledTexts = [];
    for (const bk of [...recalledBookKeys]) {
      const text = recallByBookKey(bk);
      if (text) recalledTexts.push({ chunkKey: bk, text: text.slice(0, 2000) });
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const result = {
      questionId: q.id,
      question: q.question,
      zone: q.zone,
      totalNouns: nounIndex.nouns.length,
      coarseYesCount: coarseYes.size,
      scoredCount: scored.size,
      selectedCount: scoredList.length,
      topRecallCount: TOP_RECALL,
      failedBatches: coarseFailedBatches,
      tokenCost: {
        coarsePromptTokens,
        coarseCompletionTokens,
        scorePromptTokens,
        scoreCompletionTokens,
        totalPromptTokens,
        totalCompletionTokens,
      },
      elapsedSecs: parseFloat(elapsed),
      scoredNouns: scoredList,
      recallItems,
      lowItems,
      recalledTexts,
    };

    allResults.push(result);
    console.log(`  召回 bookKey 数(去重后): ${recalledBookKeys.size}, 低分词: ${lowItems.length}, 耗时: ${elapsed}s`);

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allResults, null, 2), 'utf-8');
    console.log(`  已增量保存到: ${OUTPUT_PATH}`);
  }

  console.log(`\n完成，结果已保存: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
