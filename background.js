importScripts('engine.js');
const E = DouyinReplyEngine;
const BACKEND_VERSION = '0.4.3';
function failure(code, message) { return Object.assign(new Error(message), { code }); }
const active = new Map();
const trustedStorage = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]);
function isPopup(sender) { return sender.url === chrome.runtime.getURL('popup.html'); }
function isChat(sender) {
  try { const url = new URL(sender.url); return Number.isInteger(sender.tab?.id) && sender.frameId === 0 && url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com')); } catch { return false; }
}
async function loadConfig() {
  await trustedStorage;
  const { aiConfig = {} } = await chrome.storage.local.get('aiConfig');
  const { apiKey: sessionKey } = await chrome.storage.session.get('apiKey');
  return { ...aiConfig, apiKey: sessionKey || aiConfig.apiKey || '' };
}
async function complete(key, buildBody, timeoutMs = 25000) {
  if (active.has(key)) throw new Error('上一条 AI 请求尚未结束');
  const controller = new AbortController();
  active.set(key, controller);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const config = E.validateConfig(await loadConfig());
    if (!(await chrome.permissions.contains({ origins: [new URL(config.endpoint).origin + '/*'] }))) throw new Error('请在扩展中保存设置并允许访问 AI 接口');
    const response = await fetch(config.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify(buildBody(config)), signal: controller.signal,
      credentials: 'omit', redirect: 'error', cache: 'no-store'
    });
    if (!response.ok) {
      const hints = { 401: 'API Key 无效或已过期', 403: '没有使用此模型或接口的权限', 404: '接口地址或模型名称不正确', 429: '请求限流或额度不足' };
      throw new Error(hints[response.status] || `AI 服务返回 HTTP ${response.status}`);
    }
    return { reply: E.extractReply(await response.json()) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`AI 请求已取消或超过 ${Math.round(timeoutMs / 1000)} 秒，未自动重试`);
    if (error instanceof TypeError) throw new Error('无法连接 AI 服务，请检查接口地址、网络和服务状态');
    if (error instanceof SyntaxError) throw new Error('AI 服务返回了无法解析的数据');
    throw error;
  } finally { clearTimeout(timeout); if (active.get(key) === controller) active.delete(key); }
}
function generate(history, key) { return complete(key, config => E.buildRequest(config, history)); }
function distill(samples, key) { return complete(key, config => E.buildDistillRequest(config, samples), 60000); }
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith('ai:')) return;
  (async () => {
    const popup = isPopup(sender), chat = isChat(sender);
    if (message.type === 'ai:capabilities' && (popup || chat)) {
      return { backendVersion: BACKEND_VERSION, installedVersion: chrome.runtime.getManifest().version, capabilities: ['reply', 'distill'] };
    }
    if (!popup && !chat) {
      throw failure('AI_SOURCE_REJECTED', `后台 ${BACKEND_VERSION} 未识别此请求来源。请在抖音聊天页的主窗口打开扩展，刷新页面后重新设置；其他网站和内嵌页面不支持。`);
    }
    if (message.clientVersion && message.clientVersion !== BACKEND_VERSION) {
      throw failure('AI_VERSION_MISMATCH', `页面脚本 ${message.clientVersion} 与后台 ${BACKEND_VERSION} 不一致。请在 Edge 扩展管理页重新加载扩展，再刷新抖音页面。`);
    }
    if (isPopup(sender)) {
      if (message.type === 'ai:settings') return { config: await loadConfig() };
      if (message.type === 'ai:save') {
        const config = E.validateConfig(message.config);
        await trustedStorage;
        if (!(await chrome.permissions.contains({ origins: [new URL(config.endpoint).origin + '/*'] }))) throw new Error('尚未允许访问这个接口');
        for (const controller of active.values()) controller.abort();
        const { apiKey, ...publicConfig } = config;
        await chrome.storage.session.set({ apiKey });
        await chrome.storage.local.set({ aiConfig: { ...publicConfig, ...(config.rememberKey ? { apiKey } : {}) } });
        await chrome.storage.local.remove('rules');
        return { status: 'AI 设置已保存。' };
      }
      if (message.type === 'ai:test') return generate([{ role: 'user', content: '你好，今天想随便聊聊天。' }], 'test');
    }
    if (isChat(sender)) {
      const key = sender.tab.id;
      if (message.type === 'ai:cancel') { active.get(key)?.abort(); return { ok: true }; }
      if (message.type === 'ai:reply') return generate(message.history, key);
      if (message.type === 'ai:distill') {
        const result = await distill(message.samples, key);
        return { style: result.reply };
      }
    }
    throw failure('AI_UNSUPPORTED_ACTION', `后台 ${BACKEND_VERSION} 不支持此入口的请求操作。请确认加载的是完整的新版扩展目录。`);
  })().then(respond, error => respond({ error: error.message, code: error.code || 'AI_REQUEST_FAILED', backendVersion: BACKEND_VERSION }));
  return true;
});
