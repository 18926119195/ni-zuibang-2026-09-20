# 旧代码：s1-llm-fill.js（改造前）

> 说明：改造前版本从 `missedNounSamples` 读取"疑似漏词"截断，这些截断只有全局
> start/end，然后在全局拼接的 fullText 里做上下文窗口搜索定位。

```javascript
import fs from 'fs';

const REPORT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s0-quality-report.json';
const S0_HITS_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s0-hits.json';
const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const OUTPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s1-nouns-with-offsets.json';

// ⚠️ 关键点：全局拼接 fullText（与 validate-s0-quality.js / merge-s0-s1.js 必须保持一致）
function buildPureTextTable(bookIndex) {
  const entries = [];
  let offset = 0;
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue;
    const text = atomSearchText(chunk).trim();
    if (!text) continue;
    const startOffset = offset;
    const endOffset = offset + text.length;
    entries.push({ chunkKey: chunk.key, page: chunk.page, text, startOffset, endOffset });
    offset = endOffset + 1;
  }
  const fullText = entries.map((e) => e.text).join('\n');
  return { fullText, entries };
}

function buildBatchPrompt(truncations) {
  // ⚠️ 截断只标注全局位置，不带 chunkKey
  const sections = truncations.map((trunc, idx) => {
    return `[截断${idx + 1}] (位置 ${trunc.start}-${trunc.end})\n${trunc.text}`;
  }).join('\n\n');

  return `你是一个精确的语言学名词提取器。请从以下多个文本截断中提取**所有名词性成分**...
${sections}
请返回JSON数组（只返回JSON，不要其他文字）：`;
}

// ⚠️ 关键点：在全局 fullText 里搜索，用上下文窗口兜底，找不到就退化成全文搜索
function locateNounInFullText(noun, fullText, truncStart, truncEnd, contextWindow = 50, s0HitIntervals = []) {
  if (!isValidNoun(noun)) return [];

  const fullTextLower = fullText.toLowerCase();
  const needle = noun.toLowerCase().trim();
  const offsets = [];

  const searchStart = Math.max(0, truncStart - contextWindow);
  const searchEnd = Math.min(fullText.length, truncEnd + contextWindow);
  const searchRegion = fullText.slice(searchStart, searchEnd);
  const searchRegionLower = searchRegion.toLowerCase();

  let from = 0;
  while (from < searchRegionLower.length) {
    const at = searchRegionLower.indexOf(needle, from);
    if (at < 0) break;

    const globalStart = searchStart + at; // ⚠️ 全局位移
    const globalEnd = globalStart + needle.length;

    // ⚠️ 防污染检查：与全局的 s0HitIntervals（扁平数组）逐个比较，是否重叠
    const overlapsS0 = s0HitIntervals.some((interval) => {
      return !(globalEnd <= interval.start || globalStart >= interval.end);
    });

    if (!overlapsS0) {
      const inOriginalTrunc = globalStart >= truncStart && globalEnd <= truncEnd;
      const inContextWindow = globalStart >= searchStart && globalEnd <= searchEnd;
      offsets.push({
        start: globalStart,
        end: globalEnd,
        confidence: inOriginalTrunc ? 'high' : (inContextWindow ? 'medium' : 'low'),
      });
    }

    from = at + needle.length;
  }

  // ⚠️ 如果上下文窗口内没找到，退化成整个 fullText 全文搜索（风险最高：可能跨 chunk 误匹配）
  if (offsets.length === 0) {
    let from = 0;
    while (from < fullTextLower.length && offsets.length < 5) {
      const at = fullTextLower.indexOf(needle, from);
      if (at < 0) break;

      const globalStart = at;
      const globalEnd = at + needle.length;

      const overlapsS0 = s0HitIntervals.some((interval) => {
        return !(globalEnd <= interval.start || globalStart >= interval.end);
      });

      if (!overlapsS0) {
        offsets.push({ start: globalStart, end: globalEnd, confidence: 'low' });
      }

      from = at + needle.length;
    }
  }

  return offsets;
}

async function main() {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));
  const missedNounSamples = report.missedNounSamples || []; // ⚠️ 只有 {start, end, text}，无 chunkKey

  let s0HitIntervals = [];
  const s0Hits = JSON.parse(fs.readFileSync(S0_HITS_PATH, 'utf-8'));
  s0HitIntervals = s0Hits.hits || []; // ⚠️ 扁平数组，全局位移

  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureTextTable = buildPureTextTable(docuverse.bookIndex);
  const fullText = pureTextTable.fullText; // ⚠️ 重新构建一次全局 fullText

  const truncationsToProcess = missedNounSamples;
  const batches = [];
  for (let i = 0; i < truncationsToProcess.length; i += 8) {
    batches.push({ batchId: Math.floor(i / 8) + 1, truncations: truncationsToProcess.slice(i, i + 8) });
  }

  const batchResults = await processBatchesParallel(batches, 5);

  const s1Nouns = new Map();
  for (const batchResult of batchResults) {
    if (!batchResult.ok) continue;
    const batch = batches.find((b) => b.batchId === batchResult.batchId);
    for (const item of batchResult.parsed) {
      const trunc = batch.truncations[item.trunc_id - 1];
      for (const noun of item.nouns) {
        const id = noun.toLowerCase().trim().replace(/\s+/g, '_');
        if (id.length < 2) continue;

        // ⚠️ 在全局 fullText 里定位，trunc.start/end 都是全局位移
        const offsets = locateNounInFullText(noun, fullText, trunc.start, trunc.start + trunc.length, 50, s0HitIntervals);
        if (offsets.length === 0) continue;

        if (!s1Nouns.has(id)) {
          s1Nouns.set(id, { id, surface: noun, offsets: [], sourceTruncIds: [] });
        }
        const entry = s1Nouns.get(id);
        entry.offsets.push(...offsets); // ⚠️ 只有 {start, end}，无 chunkKey
        entry.sourceTruncIds.push(trunc.start);
      }
    }
  }

  const s1Entries = [...s1Nouns.values()];
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ nouns: s1Entries }, null, 2), 'utf-8');
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
```

## 核心问题

1. **重新构建全局 fullText**：每个脚本（validate-s0-quality.js / merge-s0-s1.js / s1-llm-fill.js）都各自独立调用 `buildPureTextTable`，只要三处逻辑有一丝不一致（比如未来改了 `atomSearchText` 的清洗规则却只改了一处），全局位移就会全部错位
2. **截断样本无 chunkKey**：`missedNounSamples` 里的截断只知道自己在全局 fullText 中的 start/end，不知道属于哪个 chunk，事后要反查非常麻烦
3. **s0HitIntervals 是扁平数组**：防污染检查要把每个候选位置和全部 s0 命中区间逐一比较（O(n) 循环），文档越大越慢
4. **全文兜底搜索风险最高**：如果截断附近的上下文窗口没搜到，会退化成整个 fullText 全文搜索，容易匹配到其他 chunk 里同名的词，造成位置误配
