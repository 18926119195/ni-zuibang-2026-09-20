/**
 * 纯文表构建公共模块（chunk-scoped 架构的唯一真相来源）
 *
 * 这四个函数原来在 validate-s0-quality.js / s1-llm-fill.js /
 * merge-s0-s1.js / recall-nouns-llm.js 里各自复制了一份完全相同的实现。
 * chunk-scoped 架构要求四个脚本对"哪些 chunk 可检索""chunk 文本怎么清洗"
 * 的判断必须逐字节一致，否则同一个 chunk 在不同脚本里算出来的局部位移
 * 会对不上，导致 s0/s1/merge/recall 之间的 offsets 错位。
 * 因此这里统一实现，四个脚本改为 import 这个模块，不再各自维护副本。
 */

// 清理 HTML/Markdown 排版标记残留（<div>、<sup>、<table> 等），
// 避免 spaCy 把标签文字和真实词粘连成假名词（如 "/div"、"sup>1</sup"）。
export function stripHtmlTags(text) {
  return text
    .replace(/<\/?(?:div|table|tr|td|th|thead|tbody|sup|sub|span|p|br)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '');
}

// 清理 PDF→Markdown 转换残留的 LaTeX 数学公式片段（如 "\varphi_1"、"d^{+}$"），
// 避免被 s0 规则误判为名词（\Phi、\circ 等），污染名词表和拓扑邻域关系。
export function stripLatexResidue(text) {
  return text
    .replace(/\$\$[^$]*\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\\[a-zA-Z]+(?:\{[^{}]*\})*/g, ' ')
    .replace(/\\+/g, ' ')
    .replace(/[\^_]\{[^{}]*\}/g, ' ')
    .replace(/\s{2,}/g, ' ');
}

export function atomSearchText(chunk) {
  const text = chunk.faces?.text?.content?.trim();
  if (text && text.length >= 8) return stripLatexResidue(stripHtmlTags(text));
  const raw = (chunk.content || '').trim();
  if (raw && !raw.startsWith('[FIG:') && raw.length >= 8) return stripLatexResidue(stripHtmlTags(raw));
  if (text) return stripLatexResidue(stripHtmlTags(text));
  const note = (chunk.faces?.fig?.note || '').trim();
  return stripLatexResidue(stripHtmlTags(
    note
      .replace(/请依据可见版面回答[^。]*。?/g, '')
      .replace(/勿编造未提供的文字[^。]*。?/g, '')
      .replace(/无文字层\/未OCR[^。]*。?/g, '')
      .trim(),
  ));
}

export function isRetrievableAtom(chunk) {
  const t = atomSearchText(chunk);
  if (t.length < 4) return false;
  if (chunk.kind === 'fig' && t.length < 24 && !chunk.faces?.text) return false;
  // 无OCR文字层的图脸占位说明（书名+Z-Library+页码+"无文字层/未OCR..."）
  // 超过24字符阈值会被误判为正文，导致 "Z-Library"/"p.39" 等书源元数据
  // 被当成名词抽取。这类占位没有真实版面内容，直接排除。
  if (chunk.kind === 'fig' && !chunk.faces?.text) {
    const rawNote = chunk.faces?.fig?.note || '';
    if (/无文字层|未OCR/.test(rawNote)) return false;
  }
  return true;
}

/**
 * 构建 chunk-scoped 纯文表：不拼接全局 fullText，只返回按 chunk
 * 独立存储的 { chunkKey, page, text } 数组。位移量由调用方在
 * 各自 chunk 的 text 内部计算（局部位移），不存在全局偏移的概念。
 */
export function buildPureTextTable(bookIndex) {
  const entries = [];
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue;
    const text = atomSearchText(chunk).trim();
    if (!text) continue;
    entries.push({ chunkKey: chunk.key, page: chunk.page, text });
  }
  return { entries };
}
