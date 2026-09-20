/**
 * s0 质量验证脚本
 *
 * 目的：把 spaCy 抽取的名词（作为 s0 候选）与"纯文表"逐位对比，
 * 计算覆盖率（命中率）与"剩余文"（未命中的截断），
 * 用于判断是否可以进入 LLM 兜底（s1 补缺）阶段。
 *
 * 用法：
 *   node validate-s0-quality.js <docuverse.json路径>
 */

import fs from 'fs';
import path from 'path';
import { buildPureTextTable } from './src/core/pureTextTable.js';

const SPACY_URL = 'http://localhost:5001/extract_nouns';

const filePath = process.argv[2] ||
  'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';

// ---------- 1. 纯文表构建逻辑已提取到 src/core/pureTextTable.js（四个脚本共用，避免逻辑分裂）----------

// ---------- 2. 逐 chunk 标注：spaCy 已经直接返回每个 chunk 内的局部 start/end，----------
// 不再需要在全文里重新做字符串搜索定位。这里只是把同一个 chunk 内的 spaCy 命中
// 聚合成 hitMask（按 chunk 局部长度），用于统计覆盖率和提取"剩余文"。

function buildHitMaskForChunk(chunkText, nounsInChunk) {
  const hitMask = new Array(chunkText.length).fill(false);
  const hits = [];
  for (const n of nounsInChunk) {
    const { start, end, surface } = n;
    if (start < 0 || end > chunkText.length || start >= end) continue;
    let alreadyHit = false;
    for (let i = start; i < end; i++) {
      if (hitMask[i]) { alreadyHit = true; break; }
    }
    if (!alreadyHit) {
      for (let i = start; i < end; i++) hitMask[i] = true;
      hits.push({ surface, start, end });
    }
  }
  return { hitMask, hits };
}

// ---------- 3. 从命中掩码提取该 chunk 内的"剩余文"（未命中的有序截断） ----------
// 返回的 start/end 是 chunk 局部位移，附带 chunkKey 供后续定位。
//
// 过滤策略：不再用固定字符数 minLen 卡"是否送 LLM"，因为法语两个名词命中之间
// 天然会留下冠词/介词/连词/代词组成的短残片（"et l'"、"de la"、"aux" 等），
// 这些残片本身不含被 spaCy 漏掉的实词，送进 LLM 只会制造噪声（LLM 在小上下文里
// 容易把这些虚词误判成名词性成分）。
// 真正的判断标准是：这段残文的 token 里，是否存在至少一个"非纯虚词"的 token。
// 只要有一个 token 不在虚词表里，就可能是被 spaCy 漏掉的实词，才送 LLM 补缺。

const FRENCH_FUNCTION_WORDS = new Set([
  // 冠词/缩合冠词
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'au', 'aux',
  // 介词
  'de', 'à', 'a', 'en', 'sur', 'sous', 'dans', 'par', 'pour', 'avec', 'sans',
  'vers', 'chez', 'entre', 'depuis', 'pendant', 'devant', 'derrière', 'jusque', 'jusqu',
  'contre', 'selon', 'malgré', 'outre', 'parmi', 'hors',
  // 连词
  'et', 'ou', 'ni', 'mais', 'donc', 'car', 'or', 'que', 'qu', 'si', 's',
  'comme', 'quand', 'lorsque', 'puisque', 'quoique',
  // 代词/关系代词
  'qui', 'quoi', 'dont', 'où', 'ce', 'cet', 'cette', 'ces', 'celui', 'celle', 'ceux', 'celles',
  'il', 'elle', 'ils', 'elles', 'on', 'nous', 'vous', 'je', 'tu', 'te', 't', 'me', 'm',
  'lui', 'leur', 'leurs', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'mon', 'ma', 'mes',
  'y', 'en2', 'se', 'soi',
  // 缩合形式残留的单字母 token（de→d'、ne→n'、je→j'、ce/c'est→c'、si→s' 的省略后单字母形式）
  'd', 'n', 'j', 'c',
  // 常见短助动/系动词形式（不含名词信息，只是句法胶水）
  'est', 'sont', 'être', 'a', 'ont', 'avoir', 'fut', 'était', 'étaient',
  // 常见虚词副词
  'ne', 'pas', 'plus', 'moins', 'très', 'bien', 'aussi', 'ainsi', 'alors', 'donc',
  'là', 'ici', 'déjà', 'encore', 'toujours', 'jamais', 'peu', 'trop',
  // 标点/连接符号本身不算词，会被下面的 tokenize 过滤掉
]);

// 把残文切成"词"级 token（去掉标点、连字符两侧空白），全部转小写比较。
// 缩合形式（d' l' qu' n' s' j' m' t'）里的省略号已经在 split 时按非字母字符切开，
// 剩下的单字母部分（d/l/qu/n/s/j/m/t）在上面的虚词表里都能命中。
function tokenizeResidual(text) {
  return text
    .toLowerCase()
    .split(/[^a-zàâäéèêëïîôöùûüçœæ]+/i)
    .filter((t) => t.length > 0);
}

// 判断残文是否"全部由虚词 token 组成"（不含任何可能的实词）。
// 空 token 列表（纯标点/纯空白）视为全虚词，直接跳过。
function isAllFunctionWords(text) {
  const tokens = tokenizeResidual(text);
  if (tokens.length === 0) return true;
  return tokens.every((t) => FRENCH_FUNCTION_WORDS.has(t));
}

function extractResidualTruncationsForChunk(chunkText, hitMask, chunkKey, page, minLen = 3) {
  const truncations = [];
  let i = 0;
  while (i < chunkText.length) {
    if (!hitMask[i]) {
      let j = i;
      while (j < chunkText.length && !hitMask[j]) j++;
      const text = chunkText.slice(i, j).trim();
      if (text.length >= minLen && !isAllFunctionWords(text)) {
        truncations.push({ chunkKey, page, start: i, end: j, text });
      }
      i = j;
    } else {
      i++;
    }
  }
  return truncations;
}

// ---------- 主流程 ----------

async function main() {
  console.log('读取语料文件:', filePath);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);

  if (data.kind !== 'docuverse-corpus' || !data.bookIndex?.chunks) {
    console.error('不是有效的 docuverse-corpus 文件，或缺少 bookIndex.chunks');
    process.exit(1);
  }

  const pureTextTable = buildPureTextTable(data.bookIndex);
  const entries = pureTextTable.entries;
  console.log(`纯文表构建完成：chunks ${entries.length} 个（不再拼接全局 fullText）`);

  // 按 chunk 调用 spaCy，存储 chunkKey + 局部位移
  console.log('按 chunk 并发调用 spaCy 抽取名词...');
  
  const allNouns = []; // { surface, chunkKey, start, end, page }
  const CONCURRENCY = 10; // 并发数
  let processed = 0;

  const processChunk = async (entry) => {
    try {
      const spacyRes = await fetch(SPACY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: entry.text,
          include_proper_nouns: true,
          include_nouns: true,
          min_length: 2,
        }),
      });
      const spacyResult = await spacyRes.json();
      
      const chunkNouns = [
        ...spacyResult.nouns.map((n) => ({
          surface: n.surface,
          chunkKey: entry.chunkKey,
          start: n.start,
          end: n.end,
          page: entry.page,
        })),
        ...spacyResult.noun_phrases.map((p) => ({
          surface: p.surface,
          chunkKey: entry.chunkKey,
          start: p.start,
          end: p.end,
          page: entry.page,
        })),
      ];
      
      processed++;
      process.stdout.write(`\r  进度: ${processed}/${entries.length} chunks`);
      
      return chunkNouns;
    } catch (err) {
      console.warn(`\n  ⚠️  chunk ${entry.chunkKey} 处理失败: ${err.message}`);
      processed++;
      return [];
    }
  };

  // 并发处理
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processChunk));
    allNouns.push(...batchResults.flat());
  }

  console.log(`\nspaCy 抽取完成: ${allNouns.length} 个名词/短语（含 chunkKey + 局部位置信息）`);

  // 按 chunkKey 分组名词命中，逐 chunk 计算 hitMask 和剩余文
  const nounsByChunk = new Map(); // chunkKey -> [{surface, start, end}]
  for (const n of allNouns) {
    if (!nounsByChunk.has(n.chunkKey)) nounsByChunk.set(n.chunkKey, []);
    nounsByChunk.get(n.chunkKey).push(n);
  }

  let totalChars = 0;
  let hitChars = 0;
  let totalHits = 0;
  const allResiduals = []; // { chunkKey, page, start, end, text } (chunk 局部位移)

  for (const entry of entries) {
    totalChars += entry.text.length;
    const chunkNouns = nounsByChunk.get(entry.chunkKey) || [];
    const { hitMask, hits } = buildHitMaskForChunk(entry.text, chunkNouns);
    hitChars += hitMask.filter(Boolean).length;
    totalHits += hits.length;
    const residuals = extractResidualTruncationsForChunk(entry.text, hitMask, entry.chunkKey, entry.page, 3);
    allResiduals.push(...residuals);
  }

  const residualChars = allResiduals.reduce((s, r) => s + r.text.length, 0);

  console.log('\n========== 统计（仅供参考，不再作为是否进入 s1 的判断依据） ==========');
  console.log(`chunk 数: ${entries.length}, 总字符数: ${totalChars}`);
  console.log(`s0 命中词条数: ${totalHits}`);
  console.log(`剩余文(截断)数量: ${allResiduals.length}, 总字符数: ${residualChars}`);

  // ---------- 输出 s0 命中位置表（供 s1 补缺去重/防污染使用） ----------
  // 位置以 chunkKey + 局部 start/end 表示，按 chunkKey 分组存储，供 s1 按 chunk 做区间重叠检测。
  const s0HitsPath = 'C:\\Users\\Administrator\\Desktop\\ni-zuibang-master\\s0-hits.json';
  const s0HitsOutput = {
    chunkCount: entries.length,
    hitCount: totalHits,
    // 按 chunkKey 分组，组内按 start 排序
    hitsByChunk: [...nounsByChunk.entries()].map(([chunkKey, nouns]) => ({
      chunkKey,
      hits: nouns
        .map((n) => ({ surface: n.surface, id: n.surface.toLowerCase().trim(), start: n.start, end: n.end }))
        .sort((a, b) => a.start - b.start),
    })),
  };
  fs.writeFileSync(s0HitsPath, JSON.stringify(s0HitsOutput), 'utf-8');
  console.log(`\ns0 命中位置表已写入: ${s0HitsPath}（${totalHits} 条，按 chunkKey 分组，供 s1 去重防污染）`);

  // ---------- 输出全部剩余区间（不做分类过滤，全部送给 s1 补缺，避免漏词） ----------
  // 之前这里会用 classifyResidual() 把残留分成 html_noise/pure_function_word/
  // short_function_word/possible_missed_noun 四类，只把最后一类送给 s1，
  // 其余三类直接丢弃不再处理。这会丢失一部分位移量（哪怕虚词间隙里混杂着
  // 真实漏掉的名词也不会被发现）。现在改为：不分类，把每个 chunk 内所有
  // 未命中的残留区间原样全部输出，交给 s1 自己判断有没有名词。
  const outPath = 'C:\\Users\\Administrator\\Desktop\\ni-zuibang-master\\s0-quality-report.json';
  const report = {
    sourceFile: path.basename(filePath),
    chunkCount: entries.length,
    totalChars,
    hitChars,
    hitCount: totalHits,
    residualCount: allResiduals.length,
    residualChars,
    // 全部残留区间，chunkKey + chunk 局部 start/end，供 s1-llm-fill.js 直接读取
    residuals: allResiduals.map((r) => ({
      chunkKey: r.chunkKey,
      page: r.page,
      start: r.start,
      end: r.end,
      length: r.text.length,
      text: r.text,
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`完整残留区间已写入: ${outPath}（${allResiduals.length} 条，全部送 s1，不做分类过滤）`);
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
