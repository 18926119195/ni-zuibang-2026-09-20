/**
 * Exp32 移植版（V2-compact，已通过3问题×3版本实测确定）：
 * 生成支持多材料引用的多路径推理 Prompt
 *
 * 输入: candidate-texts-for-llm.json（build-prompt-with-traceback.js 的输出）
 * 输出: multipath-prompt-<questionId>.txt
 *
 * 核心设计（V2版，见 prompt-optimization-final-report.md）：
 * 1. 每个推理步骤可以引用一个或多个材料【【N】】
 * 2. 保留"引用规范"和"推理策略"说明 —— 实测证明删除后多材料引用率会从
 *    12.3处/答案暴跌到0.7处/答案，是维持多材料交叉推理能力的关键指令
 * 3. 去掉了"思路"行和"综合结论"部分（对推理质量无影响，纯省token）
 * 4. Prompt 中只含材料编号 + 命中名词数 + 文本，不含 chunkKey（chunkKey 只在后台溯源表里）
 *
 * 用法：
 *   node generate-multipath-prompt.js Z1-Q1
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_PATH = process.env.CANDIDATE_TEXTS_PATH || path.join(__dirname, 'candidate-texts-for-llm.json');
const questionId = process.argv[2];

if (!questionId) {
  console.error('用法: node generate-multipath-prompt.js <questionId>');
  process.exit(1);
}

if (!fs.existsSync(CANDIDATE_PATH)) {
  console.error(`未找到 ${CANDIDATE_PATH}，请先运行 node build-prompt-with-traceback.js`);
  process.exit(1);
}

const candidateTexts = JSON.parse(fs.readFileSync(CANDIDATE_PATH, 'utf-8'));
const entry = candidateTexts.find((e) => e.questionId === questionId);
if (!entry) {
  console.error(`未找到问题 ${questionId}，可用问题: ${candidateTexts.map((e) => e.questionId).join(', ')}`);
  process.exit(1);
}

const { question, chunks } = entry;
console.log('='.repeat(80));
console.log(`生成多路径 Prompt: [${questionId}] ${question}`);
console.log(`材料数: ${chunks.length}`);
console.log('='.repeat(80));

const lines = [];
lines.push(`问题：${question}`);
lines.push('');
lines.push('材料：');
lines.push('');

for (const chunk of chunks) {
  lines.push(`【【${chunk.id}】】(命中: ${chunk.nounCount})`);
  lines.push(chunk.text);
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push('要求：输出2-4条独立推理路径，每条路径包含多个步骤，每步可引用一个或多个材料【【N】】。');
lines.push('');
lines.push('格式：');
lines.push('');
lines.push('# 路径一：[标题]');
lines.push('');
lines.push('步骤1：使用【【X】】，提取...');
lines.push('步骤2：综合【【Y】】【【Z】】，对比...');
lines.push('');
lines.push('结论：[此路径结论]');
lines.push('');
lines.push('（继续路径二、三...）');
lines.push('');
lines.push('**引用规范**：');
lines.push('- 单个材料：使用【【N】】，提取...，判断...');
lines.push('- 多个材料：综合【【N】】【【M】】，对比/交叉验证/综合提取...');
lines.push('');
lines.push('**推理策略**：');
lines.push('- 对比论证：对比不同材料中的矛盾或差异');
lines.push('- 交叉验证：从多个材料中找到互相支撑的证据');
lines.push('- 综合支撑：从多处提取一致的特征或模式');

const prompt = lines.join('\n');
const outputPath = path.join(__dirname, `multipath-prompt-${questionId}.txt`);
fs.writeFileSync(outputPath, prompt, 'utf-8');

console.log(`\n✅ Prompt 已保存: ${outputPath}`);
console.log(`   长度: ${prompt.length} 字符, 材料数: ${chunks.length}`);
console.log('\n下一步: node run-reasoning.js ' + questionId);
