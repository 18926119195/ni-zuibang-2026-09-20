#!/usr/bin/env node
/**
 * 一键执行完整流程：从名词召回到多路径推理
 * 
 * 前提：final-noun-index.json 已存在
 * 
 * 用法：
 *   node run-full-pipeline.js Z1-Q1    # 单个问题
 *   node run-full-pipeline.js          # 所有问题
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const questionId = process.argv[2];
const questionArg = questionId ? ` ${questionId}` : '';

console.log('='.repeat(80));
console.log('完整流程自动执行');
console.log('='.repeat(80));
console.log(`处理问题: ${questionId || '所有问题'}\n`);

// 检查前置文件
if (!fs.existsSync('final-noun-index.json')) {
  console.error('❌ 缺少 final-noun-index.json，请先执行名词表生成流程');
  process.exit(1);
}

if (!fs.existsSync('test-questions.json')) {
  console.error('❌ 缺少 test-questions.json');
  process.exit(1);
}

function runStep(step, description, command) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`步骤 ${step}: ${description}`);
  console.log(`${'='.repeat(80)}`);
  try {
    execSync(command, { stdio: 'inherit' });
  } catch (err) {
    console.error(`\n❌ 步骤 ${step} 失败`);
    process.exit(1);
  }
}

// 阶段2：名词召回
runStep(2, '名词召回（粗筛+精打分）', `node recall-nouns-llm.js${questionArg}`);

// 阶段3：构建推理输入
runStep(3, '构建推理输入（拓扑链+溯源映射）', `node build-prompt-with-traceback.js${questionArg}`);

// 阶段4-5：对每个问题生成Prompt并执行推理
const candidateTexts = JSON.parse(fs.readFileSync('candidate-texts-for-llm.json', 'utf-8'));
const targetQuestions = questionId 
  ? candidateTexts.filter(q => q.questionId === questionId)
  : candidateTexts;

if (targetQuestions.length === 0) {
  console.error(`\n❌ 未找到问题 ${questionId}`);
  process.exit(1);
}

for (const q of targetQuestions) {
  runStep(4, `生成多路径Prompt [${q.questionId}]`, `node generate-multipath-prompt.js ${q.questionId}`);
  runStep(5, `执行推理 [${q.questionId}]`, `node run-reasoning.js ${q.questionId}`);
}

console.log('\n' + '='.repeat(80));
console.log('✅ 完整流程执行完毕');
console.log('='.repeat(80));
console.log(`\n输出文件:`);
console.log(`  - noun-recall-results.json`);
console.log(`  - candidate-texts-for-llm.json`);
console.log(`  - material-traceback-map.json`);
for (const q of targetQuestions) {
  console.log(`  - multipath-prompt-${q.questionId}.txt`);
  console.log(`  - reasoning-output-${q.questionId}.json`);
}
