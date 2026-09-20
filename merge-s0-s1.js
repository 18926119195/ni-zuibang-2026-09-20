/**
 * s0-s1 合并脚本：将 spaCy (s0) 和 LLM (s1) 提取的名词合并去重
 *
 * 输入：
 *   1. spaCy 抽取结果（从 validate-s0-quality.js 的中间状态）
 *   2. s1-nouns-with-offsets.json（LLM 补缺结果）
 *
 * 输出：
 *   final-noun-index.json - 最终名词索引（含位置偏移量）
 *
 * 策略：
 *   - s0 优先（spaCy 结果为主干）
 *   - s1 补缺（LLM 提取的新名词）
 *   - 去重：按标准化 ID（小写+空格转下划线）
 *   - 保留所有位置偏移量（支持检索定位）
 */

import fs from 'fs';
import { buildPureTextTable } from './src/core/pureTextTable.js';

const DOCUVERSE_PATH = process.env.DOCUVERSE_PATH || 'C:\\Users\\Administrator\\Desktop\\ni-zuibang-master\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const S1_PATH = process.env.S1_PATH || 'C:\\Users\\Administrator\\Desktop\\ni-zuibang-master\\s1-nouns-with-offsets.json';
const OUTPUT_PATH = process.env.OUTPUT_PATH || 'C:\\Users\\Administrator\\Desktop\\ni-zuibang-master\\final-noun-index.json.new';

// ---------- 纯文表构建逻辑已提取到 src/core/pureTextTable.js（四个脚本共用）----------

// ---------- 标准化名词 ID ----------
function normalizeId(surface) {
  return surface.toLowerCase().trim().replace(/\s+/g, '_');
}

// ---------- 噪声词条过滤 ----------
// 剔除两类被 spaCy 误标为名词/专有名词的噪声：
// 1) OCR/排版残留：单字母+点缩写（p. U. T. F. C. A. E.）、纯数字、纯符号、
//    "##"、"A/" "b/" 这类版式标记、希腊字母缩写（Φ.）等。
// 2) 常见法语虚词（冠词/代词/连词/副词）被误判为名词，如 de/la/le/il/elle/pas/tout 等。
const FRENCH_FUNCTION_WORDS = new Set([
  'de', 'la', 'le', 'les', 'un', 'une', 'des', 'du', 'et', 'en', 'au', 'aux',
  'ce', 'ces', 'cet', 'cette', 'son', 'sa', 'ses', 'il', 'elle', 'ils', 'elles',
  'on', 'qui', 'que', 'quoi', 'dans', 'pour', 'par', 'sur', 'pas', 'plus',
  'tout', 'tous', 'toute', 'toutes', 'ne', 'se', 'sont', 'est', 'ont', 'a',
  'ou', 'mais', 'donc', 'or', 'ni', 'car', 'si', 'y', 'lui', 'leur', 'leurs',
  'nous', 'vous', 'je', 'tu', 'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'notre',
  'votre', 'nos', 'vos', 'avec', 'sans', 'sous', 'vers', 'chez', 'entre',
]);

// OCR/排版残留：单个大写字母（含希腊字母）加可选的点，或纯数字/编号，
// 或斜杠标记的短版式片段（A/ b/），或 "##" 之类的Markdown残留。
const OCR_JUNK_RE = /^[A-Za-zΦΣ]\.$|^\d+\)?\.?$|^##+$|^[a-zA-Z]\/$|^p\.$/;

function isJunkSurface(surface) {
  const trimmed = surface.trim();
  if (OCR_JUNK_RE.test(trimmed)) return true;
  if (FRENCH_FUNCTION_WORDS.has(trimmed.toLowerCase())) return true;
  return false;
}

// ---------- 主流程 ----------
async function main() {
  console.log('========== s0 + s1 合并流程 ==========\n');

  // 1. 构建纯文表
  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureTextTable = buildPureTextTable(docuverse.bookIndex);
  const entries = pureTextTable.entries;
  console.log(`纯文表: ${entries.length} 个 chunks（不再拼接全局 fullText）\n`);

  // 2. 读取 s0-hits.json（validate-s0-quality.js 已经把 spaCy 结果按 chunkKey 分组落盘了，
  // 这里直接复用，避免再调一遍 spaCy）
  console.log('读取 s0-hits.json...');
  const S0_HITS_PATH = process.env.S0_HITS_PATH || 'C:\\Users\\Administrator\\Desktop\\ni-zuibang-master\\s0-hits.json';
  let s0HitsByChunk;
  try {
    const s0Hits = JSON.parse(fs.readFileSync(S0_HITS_PATH, 'utf-8'));
    s0HitsByChunk = new Map((s0Hits.hitsByChunk || []).map((g) => [g.chunkKey, g.hits || []]));
    console.log(`  已加载 ${s0HitsByChunk.size} 个 chunk 的 s0 命中`);
  } catch (err) {
    console.error(`\n❌ 无法读取 s0-hits.json (${S0_HITS_PATH}): ${err.message}`);
    console.error('   请先运行 validate-s0-quality.js 生成 s0-hits.json');
    process.exit(1);
  }

  // chunkKey -> page 反查表（s0-hits.json 里没存 page，需要从纯文表补上）
  const pageByChunkKey = new Map(entries.map((e) => [e.chunkKey, e.page]));

  // 把 s0-hits.json 展平为 s0RawTokens（结构与原 spaCy 调用结果一致，方便后续去重/过滤逻辑复用）
  const s0RawTokens = [];
  let processed = 0;
  for (const [chunkKey, hits] of s0HitsByChunk.entries()) {
    const page = pageByChunkKey.get(chunkKey);
    for (const h of hits) {
      s0RawTokens.push({
        surface: h.surface,
        chunkKey,
        start: h.start,
        end: h.end,
        page,
      });
    }
    processed++;
    process.stdout.write(`\r  进度: ${processed}/${s0HitsByChunk.size} chunks`);
  }
  console.log(`\ns0 名词: ${s0RawTokens.length} 个（去重前，含 chunkKey + 局部偏移量）\n`);

  // 3. 读取 s1 (LLM) 补缺结果
  let s1Data = { nouns: [] };
  if (fs.existsSync(S1_PATH)) {
    s1Data = JSON.parse(fs.readFileSync(S1_PATH, 'utf-8'));
    console.log(`s1 补缺名词: ${s1Data.nouns.length} 个\n`);
  } else {
    console.log('s1 文件不存在，跳过补缺合并\n');
  }

  // 4. 合并去重
  const mergedNouns = new Map(); // id -> { id, surface, offsets, source }

  // 先加载 s0：直接使用 spaCy 原生返回的 chunkKey + 局部偏移量，按 id 分组
  let s0JunkSkipped = 0;
  for (const token of s0RawTokens) {
    const id = normalizeId(token.surface);
    if (id.length < 2) continue;
    if (isJunkSurface(token.surface)) { s0JunkSkipped++; continue; }

    if (!mergedNouns.has(id)) {
      mergedNouns.set(id, {
        id,
        surface: token.surface,
        offsets: [],
        source: 's0-spacy',
      });
    }
    mergedNouns.get(id).offsets.push({ 
      chunkKey: token.chunkKey, 
      start: token.start, 
      end: token.end, 
      page: token.page 
    });
  }

  // 每个词条内部按 chunkKey + offset 去重（noun 和 noun_phrase 可能重复标记同一处）
  for (const entry of mergedNouns.values()) {
    const unique = new Map();
    for (const off of entry.offsets) {
      unique.set(`${off.chunkKey}-${off.start}-${off.end}`, off);
    }
    entry.offsets = [...unique.values()].sort((a, b) => 
      a.chunkKey.localeCompare(b.chunkKey) || a.start - b.start
    );
  }

  // 再加载 s1（跳过 s0 已有的），同样过滤噪声
  let s1JunkSkipped = 0;
  for (const s1Entry of s1Data.nouns) {
    if (mergedNouns.has(s1Entry.id)) continue;
    if (isJunkSurface(s1Entry.surface)) { s1JunkSkipped++; continue; }

    mergedNouns.set(s1Entry.id, {
      id: s1Entry.id,
      surface: s1Entry.surface,
      offsets: s1Entry.offsets,
      source: 's1-llm',
    });
  }

  console.log(`噪声过滤：s0 跳过 ${s0JunkSkipped} 个token，s1 跳过 ${s1JunkSkipped} 个词条\n`);

  // 5. 排序（按出现频次降序）
  const finalEntries = [...mergedNouns.values()].sort(
    (a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id),
  );

  // 6. 统计
  const s0Count = finalEntries.filter((e) => e.source === 's0-spacy').length;
  const s1Count = finalEntries.filter((e) => e.source === 's1-llm').length;
  const totalOffsets = finalEntries.reduce((sum, e) => sum + e.offsets.length, 0);

  console.log('========== 合并完成 ==========');
  console.log(`最终名词数: ${finalEntries.length} 个`);
  console.log(`  - s0 (spaCy): ${s0Count} 个`);
  console.log(`  - s1 (LLM补缺): ${s1Count} 个`);
  console.log(`总位置数: ${totalOffsets} 处`);
  console.log(`平均每词: ${(totalOffsets / Math.max(finalEntries.length, 1)).toFixed(1)} 处\n`);

  // 7. 输出
  const output = {
    meta: {
      source: 's0 + s1 合并',
      chunkCount: entries.length,
      totalNouns: finalEntries.length,
      s0Count,
      s1Count,
      totalOffsets,
      timestamp: new Date().toISOString(),
    },
    nouns: finalEntries,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`输出文件: ${OUTPUT_PATH}`);

  console.log(`\n前20个高频名词:`);
  finalEntries.slice(0, 20).forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.surface} (${e.offsets.length}次) [${e.source}]`);
  });
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
