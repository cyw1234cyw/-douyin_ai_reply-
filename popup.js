const $ = id => document.getElementById(id);
const VERSION = '0.4.3';
let tabId, savedFingerprint, backendReady = false;
const fields = ['endpoint', 'model', 'apiKey', 'style', 'profile', 'interval'];
function form() {
  return { ...Object.fromEntries(fields.map(id => [id, $(id).value])), rememberKey: $('rememberKey').checked };
}
async function ai(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type: 'ai:' + type, ...extra });
  if (result?.error) throw new Error(result.error);
  return result;
}
async function request(type, extra = {}) {
  if (!tabId) throw new Error('请在已登录的抖音网页上打开扩展');
  const result = await chrome.tabs.sendMessage(tabId, { type, ...extra });
  if (result.error) throw new Error(result.error);
  return result;
}
async function initialize() {
  let support;
  try { support = await ai('capabilities'); } catch { /* Older workers do not implement this request. */ }
  if (support?.backendVersion !== VERSION || support?.installedVersion !== VERSION || !support?.capabilities?.includes('distill')) {
    throw new Error(`扩展文件或后台尚未更新完整（界面 ${VERSION}，后台 ${support?.backendVersion || '旧版或无法确认'}）。请完整覆盖新版文件，在 Edge 扩展管理页重新加载扩展，再刷新抖音页面。`);
  }
  backendReady = true;
  const { config } = await ai('settings');
  const defaults = { endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', model: 'mimo-v2.5', interval: 15, style: DouyinReplyEngine.DEFAULT_STYLE };
  for (const id of fields) $(id).value = config[id] ?? defaults[id] ?? '';
  $('rememberKey').checked = !!config.rememberKey;
  savedFingerprint = JSON.stringify(form());
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab.url || 'about:blank');
  if (url.protocol !== 'https:' || !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) {
    $('status').textContent = '可以先配置和测试 AI，再打开抖音网页进行设置。'; return;
  }
  tabId = tab.id;
  const [{ result: injectedVersion }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: expected => {
      const current = globalThis.__douyinReplyAssistant;
      if (current === true) return 'legacy';
      if (current?.version === expected) return 'current';
      if (current?.version) return 'other';
      return 'none';
    },
    args: [VERSION]
  });
  if (injectedVersion === 'legacy') {
    await chrome.tabs.reload(tabId);
    $('status').textContent = '检测到旧版页面脚本，已自动刷新抖音页面。刷新完成后请重新打开扩展并设置。';
    return;
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['recognition.js', 'composer.js', 'content.js'] });
  $('status').textContent = (await request('status')).status;
}
$('save').onclick = async () => {
  try {
    if (!backendReady) throw new Error('请先解决上方的后台版本提示，再保存设置');
    const config = DouyinReplyEngine.validateConfig(form());
    const granted = await chrome.permissions.request({ origins: [new URL(config.endpoint).origin + '/*'] });
    if (!granted) throw new Error('未允许访问该接口，设置尚未保存');
    if (tabId) await request('stop');
    $('status').textContent = (await ai('save', { config })).status;
    savedFingerprint = JSON.stringify(form());
  } catch (error) { $('status').textContent = error.message; }
};
for (const type of ['test', 'setup', 'distill', 'preview', 'start', 'stop']) {
  $(type).onclick = async () => {
    try {
      if (!backendReady && type !== 'stop') throw new Error('后台版本尚未通过检查。请完整更新扩展、重新加载并刷新抖音页面。');
      if (['test', 'distill', 'preview', 'start'].includes(type)) {
        DouyinReplyEngine.validateConfig(form());
        if (JSON.stringify(form()) !== savedFingerprint) throw new Error('设置已修改，请先点击“保存 AI 设置”');
      }
      if (type === 'test') {
        $('test').disabled = true; $('status').textContent = 'AI 正在回复测试问候…';
        $('status').textContent = '连接成功，AI 回复：\n' + (await ai('test')).reply;
      } else if (type === 'distill') {
        $('distill').disabled = true;
        $('status').textContent = '正在读取当前会话的历史消息，请保持聊天页面打开…';
        const result = await request('distill');
        $('style').value = result.style;
        const config = DouyinReplyEngine.validateConfig(form());
        await ai('save', { config });
        savedFingerprint = JSON.stringify(form());
        $('status').textContent = `已从 ${result.sampleCount} 条不同的己方文本中学习并保存聊天风格。${result.historyNote || ''}。建议先阅读上方“聊天风格”，再进行试运行。`;
      } else {
        const result = await request(type, { interval: Number($('interval').value) });
        $('status').textContent = result.status;
        if (type === 'setup') window.close();
      }
    } catch (error) { $('status').textContent = error.message; }
    finally { $('test').disabled = false; $('distill').disabled = false; }
  };
}
initialize().catch(error => { $('status').textContent = error.message; });
