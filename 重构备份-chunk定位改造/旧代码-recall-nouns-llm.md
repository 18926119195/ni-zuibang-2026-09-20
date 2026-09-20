# 旧代码：recall-nouns-llm.js（改造前）

> 说明：改造前版本使用全局 fullText 拼接 + 全局位移量查找 chunk 的方式。

```javascript
/**
 * recall-nouns-llm.js
 * 
 * 基于 LLM 补缺的名词召回（s1 阶段）
 * 从"剩余文"（s0 未命中的区间）中用 LLM 提取额外名词
 */

import fs from 'fs';

// ⚠️ 关键点1：构建全局纯文表，用 \n 拼接所有 chunk
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
    offset = endOffset + 1; // ⚠️ +1 跳过换行符 \n
  }
  
  const fullText = entries.map((e) => e.text).join('\n'); // ⚠️ 全局拼接
  return { fullText, entries };
}

// ⚠️ 关键点2：通过全局位移量反查 chunkKey（二分查找或线性扫描）
function locateNounInFullText(noun, bookKey, truncPos) {
  const { fullText, entries } = pureTextTableByBookKey[bookKey];
  
  // ⚠️ 在全局 fullText 中搜索名词（从 truncPos 开始）
  const idx = fullText.indexOf(noun.surface, truncPos);
  if (idx === -1) {
    console.warn(`[WARN] 未找到名词 "${noun.surface}" (truncPos=${truncPos})`);
    return null;
  }
  
  // ⚠️ 通过全局位移量反查 chunk（O(n) 扫描）
  const entry = entries.find(e => idx >= e.startOffset && idx < e.endOffset);
  if (!entry) {
    console.warn(`[WARN] 无法定位 offset ${idx} 到具体 chunk`);
    return null;
  }
  
  // 检查是否与 s0 重叠
  const s0Overlap = s0ByBookKey[bookKey]?.find(s0 => 
    s0.surface === noun.surface && s0.chunkKey === entry.chunkKey
  );
  
  if (s0Overlap) {
    return null; // 已在 s0 中，跳过
  }
  
  return {
    chunkKey: entry.chunkKey,
    page: entry.page,
    localOffset: idx - entry.startOffset, // 转换成局部位移
    nextTruncPos: idx + noun.surface.length
  };
}

// ⚠️ 关键点3：spaCy 按批次处理全局 fullText
async function processBookWithSpacy(bookKey) {
  const { fullText } = pureTextTableByBookKey[bookKey];
  
  // 将全局 fullText 分批（每批 10000 字符）
  const batches = chunkText(fullText, 10000);
  let globalOffset = 0;
  
  for (const batch of batches) {
    const spacyResult = await callSpacyAPI(batch.text);
    
    // ⚠️ 将 spaCy 返回的局部位移加上 globalOffset，转换为全局位移
    const nouns = spacyResult.nouns.map(n => ({
      surface: n.text,
      start: n.start + globalOffset, // 全局位移
      end: n.end + globalOffset
    }));
    
    globalOffset += batch.text.length;
    
    // 后续通过全局位移调用 locateNounInFullText
    for (const noun of nouns) {
      const location = locateNounInFullText(noun, bookKey, noun.start);
      if (location) {
        results.push({
          surface: noun.surface,
          chunkKey: location.chunkKey,
          page: location.page,
          offset: noun.start // ⚠️ 存储的是全局位移量
        });
      }
    }
  }
  
  return results;
}

// ⚠️ 关键点4：主流程先构建全局表
async function main() {
  const bookKeys = Object.keys(docuverseData);
  
  // 为每个 book 构建全局 fullText
  const pureTextTableByBookKey = {};
  for (const bookKey of bookKeys) {
    pureTextTableByBookKey[bookKey] = buildPureTextTable(docuverseData[bookKey].bookIndex);
  }
  
  // 按 book 依次处理
  for (const bookKey of bookKeys) {
    console.log(`Processing book: ${bookKey}`);
    const results = await processBookWithSpacy(bookKey);
    saveResults(bookKey, results);
  }
}

main().catch(console.error);
```

## 核心问题

1. **内存开销大**：需要为每个 book 构建完整的 fullText（可能数十万/百万字符）
2. **位移计算复杂**：
   - spaCy 返回批次内的局部位移，需要加上 globalOffset 转成全局位移
   - 定位 chunk 时需要用全局位移在 entries 数组中线性扫描（O(n)）
3. **精度风险**：
   - 拼接符 `\n` 占用位移量，如果清洗逻辑不一致会导致偏移
   - 名词可能跨越 chunk 边界被错误识别
4. **串行处理**：无法并发调用 spaCy（必须按批次顺序累加 globalOffset）
5. **代码耦合**：fullText 的构建逻辑必须与 validate-s0-quality.js 严格一致
