# 项目进度记录

> 本文件记录 s0（spaCy 抽取）质量验证的调查过程和结论，方便下次继续。

## 今天做的事情（2026-09-20）

### 1. 背景
`validate-s0-quality.js` 用 spaCy 对法语语料（*Cartographies schizoanalytiques*, Félix Guattari）做名词抽取，
命中结果写入 `s0-hits.json`，没被命中的"残留文本"写入 `s0-quality-report.json`，
残留会送进下一阶段 s1（LLM 补缺）去判断里面是否有被 spaCy 漏检的实词。

### 2. 文件版本核实
`s0-quality-report.prev.json` ~ `prev4.json` 和当前 `s0-quality-report.json` 做了统计对比：

| 文件 | 生成时间 | chunkCount | hitCount | residualCount | residualChars |
|---|---|---|---|---|---|
| s0-quality-report.prev.json | 18:35:47 | 1447 | 24750 | 12172 | 294814 |
| s0-quality-report.prev2.json | 19:09:32 | 1447 | 24750 | 12172 | 294814 |
| s0-quality-report.prev3.json | 19:09:32 | 1447 | 24750 | 12172 | 294814 |
| s0-quality-report.prev4.json | 19:18:16 | 1447 | 24750 | 12172 | 294814 |
| s0-quality-report.json（最新） | 19:43:01 | 1447 | 24750 | 12172 | 294814 |

**结论：这几个版本数字完全一致**，说明是同一套代码逻辑今天重复跑了 5 次，不是不同代码版本的迭代结果。
`s0-hits.prev*.json` 同理，都是同一次逻辑的重复产出。

### 3. 讨论并否掉的方案：残文三分类分流
有人提出把残留文本分成三类处理：
- `mustRepair`（强制送 LLM）：按断词标记/长度<6 判断
- `mayExtract`（先跑第二次 spaCy NER，无高价值实体则丢弃）
- `discard`（纯虚词，直接丢弃）

**结论：不采纳，维持现状（不分类，全部送 s1）。** 理由：
- `discard` 类现有代码已经用 `isAllFunctionWords()`（虚词表判定）实现了，效果类似，没必要重写。
- `mayExtract` 类是无效工作：残文本身就是 spaCy 第一次没能划出边界的产物，二次调用同一个 spaCy 服务大概率还是漏检，多一次网络请求（12172 条）换不来多少增量。
- `mustRepair` 用"长度<6 且不在词典"做判断，在法语 OCR 场景不可靠——完整词和断词很难靠长度区分。
- 历史上代码里确实有过一个四分类版本（`classifyResidual()`，注释里提到分 html_noise/pure_function_word/short_function_word/possible_missed_noun 四类），后来被替换成现在的"不分类全送 s1"，原因就是分类会丢词，且这个丢失不可逆。三分类建议本质是想把已经被否掉的旧方案捡回来。

### 4. 实际运行 + 人工抽样质量对比
用当前代码重新跑了一次 `validate-s0-quality.js`（spaCy 服务跑在 `http://localhost:5001`），
对比 s0 命中样本和残留样本各抽 30 条人工看质量：

**s0 命中质量：可靠。** 抽样里的词（"Cartographies" "développement" "édifices" "Archibald" "Paul" 等）边界正确，无截断问题。

**残留内容分两类：**
1. 确认有被 spaCy 漏检的真实实词，例如 `"schizoanalytiques"`（17字符完整学术术语，无标点无虚词，被完全漏检），
   说明"全送 s1"这个策略是有效的，能捞回真实漏词。
2. 发现了一个新问题（之前统计特征分析没看出来）：**部分残留是 OCR 拼写错误导致整句话被 spaCy 完全漏检**，
   不是"两个名词间的正常缝隙"。例如：
   - `"contradictories cessent également d'être opposables l'une à l'autre pour auutant qu'elles peuvent impliquer un inevitable"`（121字符，"auutant"应为"autant"，"inevitable"缺重音）
   - `"culte-elle été absolument nécessaire?"`（"culte-elle" 疑似应为 "a-t-elle"）
   
   这类问题不是"残文分类"能解决的，根源在语料本身的 OCR 质量，需要在更早的 OCR/文本清洗阶段处理（今天未深入统计具体占比，是潜在的下一步方向）。

### 5. HTML 噪声排查
用户问残留里是否混有 HTML 标签/实体会被送进 s1。做了两轮检查：
- 严格模式匹配（`<tag>`、`&entity;`、`class=` 等）：12172 条里只 1 条命中，且是假阳性（法语引号 OCR 误读）。
- 宽松扫描（任何含 `<` `>` `&` 字符的残留）：共 17 条，逐条人工看完，全部是法语排版符号误判——
  法语引号变体（« »）、斜体标记（`*...*`）、数学大于号（"m > 1"），**没有一条是真正的 HTML 标签/实体**。

**结论：不会。这批语料没有 HTML 噪声混入 s1 输入。**

### 6. 明确"被过滤掉、不会送进 s1"的残文范围
对照 `validate-s0-quality.js` 第 95-108 行 `extractResidualTruncationsForChunk()`，只有两类残留会被挡住、不送 s1：
1. **长度 < 3 字符**的残留（`minLen = 3`，第 95 行默认值）。
2. **全部由虚词组成**的残留（`isAllFunctionWords()` 判定为真，第 68-73 行）——
   按非字母字符分词后，每个 token 都命中 `FRENCH_FUNCTION_WORDS` 词表（冠词/介词/连词/代词/助动词/虚词副词，第 55-73 行列出）。

只要残留里有一个 token 不在虚词表里（无论是真实词还是 OCR 错误拼出来的怪词），就会被保留送进 s1。
这就是为什么含 OCR 错误的长句残留（如上面第4节的例子）也会进入 s1 名单——它们不满足"全虚词"条件。

## 现状结论汇总
- **现有 s0→残文→s1 流程设计合理，不需要改动**：二层过滤（长度 + 虚词表）+ 单次 spaCy + 全部残文送 s1 补缺。
- **不需要做残文三分类分流**，理由见第3节。
- **不需要额外清洗残文里的"噪声"**（HTML、纯虚词等），因为现有代码已经把能明确排除的部分挡住了，剩下的交给 s1 判断是刻意的设计选择。

## 下一步可以做的方向（未开始，仅记录想法）
1. **统计残留里 OCR 错误的具体占比**——第4节发现的问题，目前只有零星样本，没有量化。可以写个脚本，
   用简单规则（连续重复字母、明显的键位相邻错拼、缺失重音符号模式等）粗略估计 OCR 错误密度。
2. **等 s1（LLM 补缺阶段）实际跑完一批数据后**，统计"有效补全 vs 无效噪声"的比例，
   用真实数据决定是否需要在 s0→s1 之间加一层轻量过滤，而不是凭形态特征猜测。
3. 如果发现 OCR 错误率确实高，需要考虑是否要在更早阶段（OCR/文本提取阶段）做修复或标记，
   而不是指望 s0/s1 阶段的规则或 LLM 兜底。

## 相关文件
- `validate-s0-quality.js`：s0 质量验证主脚本，包含虚词表和残文提取逻辑。
- `s0-quality-report.json`：最新一次运行的残留区间报告（12172条，送 s1 用）。
- `s0-hits.json`：最新一次运行的 spaCy 命中位置表（24750条，供 s1 去重防污染）。
- `s0-quality-report.prev*.json` / `s0-hits.prev*.json`：今天多次重复运行的历史快照，内容与最新版一致，可视为冗余备份。
