/**
 * Exp32 移植版：生成带溯源映射的双输出
 *
 * 输入: noun-recall-results.json（recall-nouns-llm.js 的输出）
 * 输出1: candidate-texts-for-llm.json   （简洁版，给 LLM 用：id/page/nounCount/text，不含 chunkKey）
 * 输出2: material-traceback-map.json   （后台映射表：chunkKey/page/hits，用于溯源，不进 Prompt）
 *
 * 用法：
 *   node build-prompt-with-traceback.js              # 处理 noun-recall-results.json 里的所有问题
 *   node build-prompt-with-traceback.js Z1-Q1         # 只处理指定问题
 */

import fs from 'fs';
import path from 'path';

const RESULTS_PATH = process.env.RECALL_RESULTS_PATH || path.join(process.cwd(), 'noun-recall-results.json');
const OUTPUT_LLM_PATH = process.env.CANDIDATE_TEXTS_PATH || path.join(process.cwd(), 'candidate-texts-for-llm.json');
const OUTPUT_TRACEBACK_PATH = process.env.TRACEBACK_MAP_PATH || path.join(process.cwd(), 'material-traceback-map.json');

const filterIds = process.argv.slice(2);

if (!fs.existsSync(RESULTS_PATH)) {
  console.error(`未找到 ${RESULTS_PATH}，请先运行 recall-nouns-llm.js 生成召回结果`);
  process.exit(1);
}

const allResults = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
const targetResults = filterIds.length
  ? allResults.filter((r) => filterIds.includes(r.questionId))
  : allResults;

console.log('='.repeat(80));
console.log('构建带溯源映射的双输出（Exp32 移植版）');
console.log('='.repeat(80));
console.log(`读取 ${RESULTS_PATH}：${allResults.length} 个问题，本次处理 ${targetResults.length} 个`);

const outputForLLM = [];
const tracebackMaps = {};

for (const entry of targetResults) {
  const { questionId, question, zone, recalledTexts = [], recallItems = [] } = entry;

  // recalledTexts 已经是 ChunkKey Set 去重后的唯一 chunk 列表（对应 Exp19/22/24 的去重结论）
  // 为每个 chunk 反查：是哪些高分名词命中了它（recallItems[].bookKeys 包含该 chunkKey）
  const chunkToHits = new Map();
  for (const item of recallItems) {
    for (const bk of item.bookKeys || []) {
      if (!chunkToHits.has(bk)) chunkToHits.set(bk, []);
      chunkToHits.get(bk).push({ noun: item.surface, score: item.score, nounId: item.id });
    }
  }

  const llmChunks = [];
  const tracebackMap = {};

  recalledTexts.forEach((chunk, idx) => {
    const materialId = idx + 1;
    const hits = chunkToHits.get(chunk.chunkKey) || [];
    const nounCount = hits.length;

    llmChunks.push({
      id: materialId,
      nounCount,
      text: chunk.text,
    });

    tracebackMap[materialId] = {
      chunkKey: chunk.chunkKey,
      nounCount,
      hits, // [{noun, score, nounId}] —— 精确到哪个名词命中了这个 chunk
    };
  });

  outputForLLM.push({ questionId, question, zone, uniqueChunks: llmChunks.length, chunks: llmChunks });
  tracebackMaps[questionId] = { question, totalMaterials: llmChunks.length, materials: tracebackMap };

  console.log(`  [${questionId}] ${question} -> ${llmChunks.length} 个材料（已去重）`);
}

fs.writeFileSync(OUTPUT_LLM_PATH, JSON.stringify(outputForLLM, null, 2), 'utf-8');
fs.writeFileSync(OUTPUT_TRACEBACK_PATH, JSON.stringify(tracebackMaps, null, 2), 'utf-8');

console.log('\n' + '='.repeat(80));
console.log(`✅ LLM 输入文件: ${OUTPUT_LLM_PATH}`);
console.log(`✅ 溯源映射文件: ${OUTPUT_TRACEBACK_PATH}`);
console.log('='.repeat(80));
console.log('下一步: node generate-multipath-prompt.js <questionId>');
