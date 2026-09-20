#!/usr/bin/env node
/**
 * 一键生成名词表：s0 spaCy抽取 → s1 LLM补缺 → merge合并
 * 
 * 前提：
 *   1. spaCy服务已启动（python spacy-sidecar/server.py）
 *   2. 已配置.env环境变量（LLM_API_KEY）
 * 
 * 用法：
 *   node generate-noun-index.js <docuverse.json路径>
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const docuversePath = process.argv[2];

if (!docuversePath) {
  console.error('❌ 请提供 docuverse.json 文件路径');
  console.log('\n用法: node generate-noun-index.js <docuverse.json路径>');
  process.exit(1);
}

if (!fs.existsSync(docuversePath)) {
  console.error(`❌ 文件不存在: ${docuversePath}`);
  process.exit(1);
}

console.log('='.repeat(80));
console.log('名词表生成流程');
console.log('='.repeat(80));
console.log(`源文件: ${docuversePath}\n`);

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

// 阶段1.1: spaCy抽取（s0）
runStep('1.1', 'spaCy名词抽取（s0阶段）', `node validate-s0-quality.js "${docuversePath}"`);

// 阶段1.2: LLM补缺（s1）
runStep('1.2', 'LLM补缺漏词（s1阶段）', `node s1-llm-fill.js`);

// 阶段1.3: 合并去重
runStep('1.3', '合并s0和s1结果', `node merge-s0-s1.js`);

console.log('\n' + '='.repeat(80));
console.log('✅ 名词表生成完毕');
console.log('='.repeat(80));
console.log(`\n输出文件:`);
console.log(`  - s0-hits.json (spaCy抽取结果)`);
console.log(`  - s0-quality-report.json (质量报告)`);
console.log(`  - s1-nouns-with-offsets.json (LLM补缺结果)`);
console.log(`  - final-noun-index.json ✅ (最终名词索引)`);
console.log(`\n下一步: 执行 node run-full-pipeline.js 开始推理流程`);
