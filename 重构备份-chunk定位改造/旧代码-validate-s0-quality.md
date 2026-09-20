# 旧代码：validate-s0-quality.js（改造前）

> 说明：这是重构前的原始版本，核心特征是构建**全局拼接的 fullText**，
> 用换行符 `\n` 连接所有 chunk 的文本，再对全文做字符串搜索定位名词。

```javascript
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

const SPACY_URL = 'http://localhost:5001/extract_nouns';

// ⚠️ 关键点：构建全局 fullText，用 \n 拼接所有 chunk
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
    offset = endOffset + 1; // +1 跳过拼接时插入的换行符 \n
  }
  const fullText = entries.map((e) => e.text).join('\n');
  return { fullText, entries };
}

// ⚠️ 关键点：一次性把全部拼接后的全文发给 spaCy
async function main() {
  const pureTextTable = buildPureTextTable(data.bookIndex);
  const fullText = pureTextTable.fullText;
  
  // 一次性处理全文
  const spacyRes = await fetch(SPACY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: fullText,
      include_proper_nouns: true,
      include_nouns: true,
      min_length: 2,
    }),
  });
  const spacyResult = await spacyRes.json();
  
  // 逐位对比（在全局 fullText 上做子串搜索）
  const { hitMask, hits } = locateSurfacesInText(fullText, allSurfaces);
  
  // ⚠️ 关键点：hits 是扁平数组，用全局 start/end 表示，不带 chunkKey
  const s0HitsOutput = {
    fullTextLength: fullText.length,
    hitCount: hits.length,
    hits: hits
      .map((h) => ({ surface: h.surface, id: h.surface.toLowerCase().trim(), start: h.start, end: h.end }))
      .sort((a, b) => a.start - b.start),
  };
  fs.writeFileSync(s0HitsPath, JSON.stringify(s0HitsOutput), 'utf-8');
}
```

## 核心问题

1. **全局拼接**：所有 chunk 用 `\n` 连接成一个大字符串
2. **全局位移量**：所有位置信息都是相对于 fullText 的全局偏移
3. **无 chunk 标记**：输出的 s0-hits.json 只有 start/end，没有 chunkKey
4. **一次性处理**：把整个 fullText 发给 spaCy，无法并发
