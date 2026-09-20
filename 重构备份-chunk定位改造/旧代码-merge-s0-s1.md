# 旧代码：merge-s0-s1.js（改造前）

> 说明：改造前版本同样依赖全局拼接的 fullText，spaCy 一次性处理全文，
> 名词位置只存全局 start/end，不带 chunkKey。

```javascript
import fs from 'fs';

const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const S1_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s1-nouns-with-offsets.json';
const OUTPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index.json';
const SPACY_URL = 'http://localhost:5001/extract_nouns';

function stripHtmlTags(text) { /* ...同现有版本... */ }
function stripLatexResidue(text) { /* ...同现有版本... */ }
function atomSearchText(chunk) { /* ...同现有版本... */ }
function isRetrievableAtom(chunk) { /* ...同现有版本... */ }

// ⚠️ 关键点：全局拼接 fullText
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

function normalizeId(surface) {
  return surface.toLowerCase().trim().replace(/\s+/g, '_');
}

async function main() {
  console.log('========== s0 + s1 合并流程 ==========\n');

  // 1. 构建纯文表（全局拼接）
  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureTextTable = buildPureTextTable(docuverse.bookIndex);
  const fullText = pureTextTable.fullText;
  console.log(`纯文表: ${fullText.length} 字符\n`);

  // 2. 获取 s0 (spaCy) 名词 —— ⚠️ 一次性调用，处理整个 fullText
  console.log('调用 spaCy 获取 s0 名词...');
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
  // spaCy 返回的 start/end 是相对于整个 fullText 的全局位移
  const s0RawTokens = [
    ...spacyResult.nouns.map((n) => ({ surface: n.surface, start: n.start, end: n.end })),
    ...spacyResult.noun_phrases.map((p) => ({ surface: p.surface, start: p.start, end: p.end })),
  ];
  console.log(`s0 名词: ${s0RawTokens.length} 个（去重前，含偏移量）\n`);

  // 3. 读取 s1 (LLM) 补缺结果
  let s1Data = { nouns: [] };
  if (fs.existsSync(S1_PATH)) {
    s1Data = JSON.parse(fs.readFileSync(S1_PATH, 'utf-8'));
  }

  // 4. 合并去重 —— ⚠️ offsets 只存 {start, end}，没有 chunkKey
  const mergedNouns = new Map();

  for (const token of s0RawTokens) {
    const id = normalizeId(token.surface);
    if (id.length < 2) continue;
    if (isJunkSurface(token.surface)) continue;

    if (!mergedNouns.has(id)) {
      mergedNouns.set(id, {
        id,
        surface: token.surface,
        offsets: [],
        source: 's0-spacy',
      });
    }
    // ⚠️ 关键点：只存全局 start/end，不知道属于哪个 chunk
    mergedNouns.get(id).offsets.push({ start: token.start, end: token.end });
  }

  for (const entry of mergedNouns.values()) {
    const unique = new Map();
    for (const off of entry.offsets) {
      unique.set(`${off.start}-${off.end}`, off); // ⚠️ 去重 key 只用全局位移
    }
    entry.offsets = [...unique.values()].sort((a, b) => a.start - b.start);
  }

  // 5. 输出
  const output = {
    meta: {
      source: 's0 + s1 合并',
      fullTextLength: fullText.length, // ⚠️ 记录的是全局字符总长
      totalNouns: mergedNouns.size,
    },
    nouns: [...mergedNouns.values()],
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
```

## 核心问题

1. **一次性调用 spaCy**：把整个文档拼接后一次性发给 spaCy 处理，无法并发，且大文档可能超出接口限制
2. **offsets 无 chunkKey**：`final-noun-index.json` 里每个名词的位置只有 `{start, end}`，全局位移量，后续任何环节要用这个位置，都必须先反查是哪个 chunk
3. **去重 key 依赖全局位移**：`${start}-${end}` 作为去重 key，如果全局拼接逻辑有任何变化（比如换行符处理方式改变），所有位移就会全部错位
