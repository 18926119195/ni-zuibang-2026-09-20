/**
 * 分析 s0-quality-report.json 中 residuals 的结构分布
 * 
 * 统计维度：
 * - 长度分布（字符数）
 * - 是否包含标点
 * - 是否包含多个词（空格数量）
 * - 是否包含特殊字符
 * - 完整度指标（开头/结尾是否像残缺片段）
 */

const fs = require('fs');
const path = require('path');

const reportPath = path.join(__dirname, 's0-quality-report.json');
const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

const { residuals } = data;

console.log('=== Residuals 结构分析 ===\n');
console.log(`总数: ${residuals.length}`);
console.log(`总字符数: ${data.residualChars}\n`);

// 1. 长度分布
const lengthBuckets = { '1-5': 0, '6-10': 0, '11-20': 0, '21-50': 0, '51+': 0 };
const lengths = residuals.map(r => r.length);
lengths.forEach(len => {
  if (len <= 5) lengthBuckets['1-5']++;
  else if (len <= 10) lengthBuckets['6-10']++;
  else if (len <= 20) lengthBuckets['11-20']++;
  else if (len <= 50) lengthBuckets['21-50']++;
  else lengthBuckets['51+']++;
});

console.log('长度分布（字符数）:');
Object.entries(lengthBuckets).forEach(([range, count]) => {
  console.log(`  ${range.padEnd(8)} : ${count.toString().padStart(5)} (${(count / residuals.length * 100).toFixed(1)}%)`);
});
console.log(`  平均长度: ${(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1)} 字符\n`);

// 2. 标点符号分析
const punctuationRegex = /[.,;:!?'"(){}[\]]/;
const withPunctuation = residuals.filter(r => punctuationRegex.test(r.text));
console.log(`包含标点: ${withPunctuation.length} (${(withPunctuation.length / residuals.length * 100).toFixed(1)}%)\n`);

// 3. 空格数量（多词片段）
const spaceCounts = residuals.map(r => (r.text.match(/\s/g) || []).length);
const multiWord = residuals.filter(r => (r.text.match(/\s/g) || []).length > 0);
console.log(`包含空格（多词）: ${multiWord.length} (${(multiWord.length / residuals.length * 100).toFixed(1)}%)`);
console.log(`  0个空格（单词）: ${residuals.length - multiWord.length}`);
console.log(`  1个空格: ${spaceCounts.filter(c => c === 1).length}`);
console.log(`  2个空格: ${spaceCounts.filter(c => c === 2).length}`);
console.log(`  3+个空格: ${spaceCounts.filter(c => c >= 3).length}\n`);

// 4. 开头/结尾特征（残缺度判断）
const startsWithLower = residuals.filter(r => /^[a-z]/.test(r.text));
const endsWithPunct = residuals.filter(r => /[.,;:!?]$/.test(r.text));
const endsWithSpace = residuals.filter(r => /\s$/.test(r.text));

console.log('完整度特征:');
console.log(`  开头小写: ${startsWithLower.length} (${(startsWithLower.length / residuals.length * 100).toFixed(1)}%)`);
console.log(`  结尾标点: ${endsWithPunct.length} (${(endsWithPunct.length / residuals.length * 100).toFixed(1)}%)`);
console.log(`  结尾空格: ${endsWithSpace.length} (${(endsWithSpace.length / residuals.length * 100).toFixed(1)}%)\n`);

// 5. 特殊字符
const withSpecialChars = residuals.filter(r => /[^\w\s.,;:!?'"(){}[\]-]/.test(r.text));
console.log(`包含特殊字符: ${withSpecialChars.length} (${(withSpecialChars.length / residuals.length * 100).toFixed(1)}%)\n`);

// 6. 抽样展示（各类型各10条）
console.log('=== 抽样展示 ===\n');

console.log('【短片段 (≤5字符)】:');
residuals.filter(r => r.length <= 5).slice(0, 10).forEach((r, i) => {
  console.log(`  ${i + 1}. "${r.text}" (len=${r.length}, page=${r.page})`);
});

console.log('\n【中等片段 (11-20字符)】:');
residuals.filter(r => r.length >= 11 && r.length <= 20).slice(0, 10).forEach((r, i) => {
  console.log(`  ${i + 1}. "${r.text}" (len=${r.length}, page=${r.page})`);
});

console.log('\n【长片段 (50+字符)】:');
residuals.filter(r => r.length > 50).slice(0, 10).forEach((r, i) => {
  console.log(`  ${i + 1}. "${r.text}" (len=${r.length}, page=${r.page})`);
});

console.log('\n【包含标点的片段】:');
withPunctuation.slice(0, 10).forEach((r, i) => {
  console.log(`  ${i + 1}. "${r.text}" (len=${r.length}, page=${r.page})`);
});

console.log('\n【单词片段（无空格）】:');
residuals.filter(r => !/\s/.test(r.text)).slice(0, 10).forEach((r, i) => {
  console.log(`  ${i + 1}. "${r.text}" (len=${r.length}, page=${r.page})`);
});

console.log('\n=== 分析完成 ===');
