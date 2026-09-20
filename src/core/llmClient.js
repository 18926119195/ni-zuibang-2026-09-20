/**
 * 统一 LLM 客户端（所有召回/推理脚本共用）
 *
 * 固定策略：DeepSeek 兼容 OpenAI 接口，模型 deepseek-chat，thinking 强制关闭。
 * 通过 .env / 环境变量提供 LLM_API_KEY，其余配置项均有默认值。
 *
 * 不依赖 dotenv 包：启动时手动读取项目根目录的 .env（若存在），
 * 只在对应环境变量尚未设置时才填充，不覆盖已有环境变量。
 */

import fs from 'fs';
import path from 'path';

function loadDotEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

export const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
export const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
export const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

if (!LLM_API_KEY) {
  console.error('缺少 API 密钥：请在 .env 中设置 LLM_API_KEY');
}

/**
 * 调用 DeepSeek（OpenAI 兼容）chat/completions 接口。
 * thinking 始终关闭，不对外暴露开关。
 */
export async function callLLM(prompt, { maxTokens = 1024, temperature = 0, retryCount = 0 } = {}) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;
  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (response.status === 429 && retryCount < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, retryCount)));
      return callLLM(prompt, { maxTokens, temperature, retryCount: retryCount + 1 });
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`DeepSeek API ${response.status}: ${errText.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    const finishReason = data.choices?.[0]?.finish_reason || '';
    return { text, usage: data.usage || null, truncated: finishReason === 'length' };
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, BASE_DELAY * Math.pow(2, retryCount)));
      return callLLM(prompt, { maxTokens, temperature, retryCount: retryCount + 1 });
    }
    console.error('LLM调用失败:', err.message);
    return null;
  }
}
