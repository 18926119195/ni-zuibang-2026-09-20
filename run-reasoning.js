/**
 * Exp34 移植版：对多路径 Prompt 运行完整推理，并注入材料溯源
 *
 * 输入:
 *   multipath-prompt-<questionId>.txt  （generate-multipath-prompt.js 的输出）
 *   material-traceback-map.json        （build-prompt-with-traceback.js 的输出）
 * 输出:
 *   reasoning-output-<questionId>.json （LLM 回答 + token 用量 + 溯源报告）
 *
 * LLM 调用统一走 src/core/llmClient.js（deepseek-chat，thinking 强制关闭）。
 *
 * 用法：
 *   node run-reasoning.js Z1-Q1
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callLLM, LLM_BASE_URL, LLM_MODEL } from './src/core/llmClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const questionId = process.argv[2];
if (!questionId) {
  console.error('用法: node run-reasoning.js <questionId>');
  process.exit(1);
}

const PROMPT_PATH = path.join(__dirname, `multipath-prompt-${questionId}.txt`);
const TRACEBACK_PATH = path.join(__dirname, 'material-traceback-map.json');
const OUTPUT_PATH = path.join(__dirname, `reasoning-output-${questionId}.json`);

if (!fs.existsSync(PROMPT_PATH)) {
  console.error(`未找到 ${PROMPT_PATH}，请先运行 node generate-multipath-prompt.js ${questionId}`);
  process.exit(1);
}
if (!fs.existsSync(TRACEBACK_PATH)) {
  console.error(`未找到 ${TRACEBACK_PATH}，请先运行 node build-prompt-with-traceback.js`);
  process.exit(1);
}

const prompt = fs.readFileSync(PROMPT_PATH, 'utf-8');
const tracebackMaps = JSON.parse(fs.readFileSync(TRACEBACK_PATH, 'utf-8'));
const tracebackEntry = tracebackMaps[questionId];
if (!tracebackEntry) {
  console.error(`溯源映射中未找到问题 ${questionId}`);
  process.exit(1);
}

console.log('='.repeat(80));
console.log(`运行完整推理: [${questionId}] ${tracebackEntry.question}`);
console.log(`LLM: ${LLM_BASE_URL} model=${LLM_MODEL} thinking=disabled`);
console.log(`材料数: ${tracebackEntry.totalMaterials}, Prompt 长度: ${prompt.length} 字符`);
console.log('='.repeat(80));

async function main() {
  const t0 = Date.now();
  const res = await callLLM(prompt, { maxTokens: 4000 });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!res) {
    console.error('LLM 调用失败，未生成推理结果');
    process.exit(1);
  }

  console.log(`\n✅ 推理完成，耗时 ${elapsed}s`);
  console.log(`Token 用量: prompt=${res.usage?.prompt_tokens ?? '-'} completion=${res.usage?.completion_tokens ?? '-'} total=${res.usage?.total_tokens ?? '-'}`);
  if (res.truncated) console.log('⚠️  输出被截断（finish_reason=length），可考虑提高 maxTokens');

  // 解析 LLM 输出中引用的材料编号，生成溯源报告
  const usedMaterials = new Set();
  for (const m of res.text.matchAll(/【【(\d+)】】/g)) {
    usedMaterials.add(parseInt(m[1], 10));
  }

  const tracebackReport = {};
  for (const materialId of usedMaterials) {
    const entry = tracebackEntry.materials[String(materialId)];
    if (entry) tracebackReport[materialId] = entry;
  }

  const output = {
    questionId,
    question: tracebackEntry.question,
    model: LLM_MODEL,
    thinking: 'disabled',
    elapsedSecs: parseFloat(elapsed),
    tokenUsage: res.usage,
    truncated: res.truncated,
    llmOutput: res.text,
    totalMaterialsAvailable: tracebackEntry.totalMaterials,
    materialsUsedCount: usedMaterials.size,
    traceback: tracebackReport,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\n引用材料数: ${usedMaterials.size}/${tracebackEntry.totalMaterials}`);
  console.log(`已保存: ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
