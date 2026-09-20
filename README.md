# 完整路径：名词表生成 → 多路径推理

本文件夹只包含**纯代码**，不含md实验报告/说明文档（本README仅作运行说明）。按顺序执行下面7步即可跑通从造名词表到多路径推理输出的完整链路。

## 目录结构

```
完整路径/
├── spacy-sidecar/server.py       # 阶段0：spaCy 名词抽取HTTP服务（Python，需单独启动）
├── validate-s0-quality.js        # 阶段1：s0 spaCy抽取 + 覆盖率验证
├── s1-llm-fill.js                 # 阶段2：s1 LLM兜底补缺（漏词补全）
├── merge-s0-s1.js                  # 阶段3：s0+s1合并去重 → final-noun-index.json（终词表）
├── recall-nouns-llm.js             # 阶段4：粗筛+精打分 → noun-recall-results.json（名词召回）
├── build-prompt-with-traceback.js  # 阶段5：召回结果 → candidate-texts-for-llm.json + 溯源表
├── generate-multipath-prompt.js    # 阶段6：candidate-texts → 多路径推理Prompt
├── run-reasoning.js                 # 阶段7：调用LLM执行多路径推理，输出最终答案
├── src/core/llmClient.js           # 公共LLM客户端（DeepSeek，各阶段脚本共用）
├── final-noun-index.json           # 已生成好的终词表（可直接跳到阶段4，跳过0-3）
├── test-questions.json             # 测试问题集
├── generate-noun-index.js          # 阶段0-3的一键封装脚本
├── run-full-pipeline.js            # 阶段4-7的一键封装脚本（单个问题）
├── package.json
└── .env.example                    # 环境变量模板（需配置 LLM_API_KEY）
```

## 运行前准备

1. 复制 `.env.example` 为 `.env`，填入 `LLM_API_KEY`（DeepSeek密钥）
2. `npm install`（仅需 `dotenv` 等极少依赖，见 `package.json`）
3. 若要从头生成名词表（阶段0-3），需额外：
   - Python 环境 + `pip install flask flask-cors spacy`，下载 `fr_core_news_sm` 模型
   - 启动 spaCy 服务：`cd spacy-sidecar && python server.py`（默认监听 `localhost:5001`）
   - 准备原始 `docuverse.json` 文档数据（脚本内路径变量 `DOCUVERSE_PATH` 需按实际路径修改）

## 分步执行

### 阶段0-3：生成名词表（终词表）

如果已经有 `final-noun-index.json`（本文件夹已附带一份现成的），可跳过这步，直接进入阶段4。

```bash
# 0. 启动 spaCy 服务（另开一个终端，保持运行）
cd spacy-sidecar
python server.py

# 1. spaCy抽取 + 质量验证（生成 s0-hits.json, s0-quality-report.json）
node validate-s0-quality.js <docuverse.json路径>

# 2. LLM兜底补缺（生成 s1-nouns-with-offsets.json）
node s1-llm-fill.js

# 3. 合并去重（生成 final-noun-index.json）
node merge-s0-s1.js
```

或者一键执行（阶段1-3，需先手动启动spaCy服务）：
```bash
node generate-noun-index.js <docuverse.json路径>
```

### 阶段4-7：名词召回 → 多路径推理

```bash
# 4. 名词召回（粗筛+精打分，生成 noun-recall-results.json）
node recall-nouns-llm.js Z1-Q1

# 5. 构建带溯源的推理输入（生成 candidate-texts-for-llm.json + material-traceback-map.json）
node build-prompt-with-traceback.js Z1-Q1

# 6. 生成多路径推理Prompt（生成 multipath-prompt-Z1-Q1.txt）
node generate-multipath-prompt.js Z1-Q1

# 7. 执行推理（调用LLM，生成 reasoning-output-Z1-Q1.json）
node run-reasoning.js Z1-Q1
```

或者一键执行阶段4-7（单个问题）：
```bash
node run-full-pipeline.js Z1-Q1
```

## 数据流总览

```
docuverse.json（原始文档）
    ↓ [validate-s0-quality.js]
s0-hits.json + s0-quality-report.json（spaCy抽取结果+覆盖率报告）
    ↓ [s1-llm-fill.js]
s1-nouns-with-offsets.json（LLM补缺的名词，带offset）
    ↓ [merge-s0-s1.js]
final-noun-index.json（终词表：全部名词+offset，去重后）
    ↓ [recall-nouns-llm.js]
noun-recall-results.json（按问题：粗筛→精打分→拓扑链→召回chunk）
    ↓ [build-prompt-with-traceback.js]
candidate-texts-for-llm.json（推理LLM输入材料） + material-traceback-map.json（溯源表）
    ↓ [generate-multipath-prompt.js]
multipath-prompt-<questionId>.txt（多路径推理Prompt）
    ↓ [run-reasoning.js]
reasoning-output-<questionId>.json（最终推理答案 + 材料溯源报告）
```

## 注意事项

- 阶段0-3依赖的原始 `docuverse.json` 文档数据未包含在本文件夹内，需按脚本顶部的路径常量自行指向实际文件
- 各脚本顶部硬编码的路径（如 `C:\Users\Administrator\Desktop\...`）大多可通过环境变量覆盖，具体见每个脚本头部注释
- `final-noun-index.json` 已经是本项目跑过一次的现成结果，体积较大（约5MB），如果只是想体验阶段4-7的召回+推理流程，可以直接用它，不必重跑阶段0-3
