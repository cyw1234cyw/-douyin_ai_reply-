(() => {
  const VERSION = '0.4.3';
  const previous = globalThis.__douyinReplyAssistant;
  if (previous?.version === VERSION) return;
  previous?.dispose?.();
  const lifecycle = { version: VERSION, dispose: null };
  globalThis.__douyinReplyAssistant = lifecycle;
  let config, running = false, timer, busy = false, preview = true;
  let interval = 15000, lastReply = 0, seen = new WeakSet(), pending = new Map(), anchors = [], timeline = [], epoch = 0;
  let status = '尚未设置。请先点选网页元素。', cancelPicker;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    .box{box-sizing:border-box;width:280px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:#fff;color:#17212d;padding:16px;border:1px solid #a9b4c4;border-radius:12px;box-shadow:0 4px 25px #0003;font:15px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}
    button{font:inherit;padding:5px 12px;margin-top:10px;cursor:pointer} strong{display:block;margin-bottom:6px}
    strong{cursor:move;touch-action:none;user-select:none} small{display:block;font-size:12px;font-weight:normal;color:#536071}
  </style><div class="box"><strong>私信回复助手 · ${VERSION}<small>拖动这里可移动提示框</small></strong><div id="text"></div><button>停止 / 取消设置</button></div>`;
  document.documentElement.append(host);
  const handle = shadow.querySelector('strong');
  let drag;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = host.getBoundingClientRect();
    drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    const rect = host.getBoundingClientRect();
    host.style.left = Math.max(0, Math.min(innerWidth - rect.width, event.clientX - drag.x)) + 'px';
    host.style.top = Math.max(0, Math.min(innerHeight - rect.height, event.clientY - drag.y)) + 'px';
    host.style.bottom = 'auto';
  });
  const endDrag = () => { drag = null; };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);
  const report = message => { status = message; shadow.getElementById('text').textContent = message; };
  function stop(message = '已停止。') {
    running = false;
    epoch++;
    chrome.runtime.sendMessage({ type: 'ai:cancel' }).catch(() => {});
    clearInterval(timer);
    pending.clear();
    if (cancelPicker) cancelPicker();
    report(message);
  }
  shadow.querySelector('button').onclick = () => stop();
  report(status);
  const textOf = element => (element.innerText ?? element.textContent ?? '').trim();
  const visible = element => element.isConnected && element.getClientRects().length > 0;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function validContext() {
    return config && location.href === config.url &&
      [config.header, config.root, config.input, config.send].every(visible) &&
      textOf(config.header) === config.title;
  }
  function pick(instruction) {
    report(instruction + ' 移动鼠标高亮目标；↑ 选父元素，↓ 返回子元素，点击确认。Esc 取消。');
    return new Promise((resolve, reject) => {
      let target, previousOutline, childStack = [];
      const highlight = element => {
        if (target) target.style.outline = previousOutline;
        target = element;
        if (target) { previousOutline = target.style.outline; target.style.outline = '3px solid #ff2858'; }
      };
      const move = event => {
        if (event.composedPath().includes(host)) return;
        childStack = [];
        highlight(event.target);
      };
      const cleanup = () => {
        highlight(null);
        document.removeEventListener('mouseover', move, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', key, true);
        cancelPicker = null;
      };
      const click = event => {
        if (event.composedPath().includes(host)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const chosen = target || event.target;
        cleanup(); resolve(chosen);
      };
      const key = event => {
        if (!['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'Escape') { cleanup(); reject(new Error('设置已取消')); }
        else if (event.key === 'ArrowUp' && target?.parentElement && target.parentElement !== document.body) {
          childStack.push(target); highlight(target.parentElement);
        } else if (event.key === 'ArrowDown' && childStack.length) highlight(childStack.pop());
      };
      cancelPicker = () => { cleanup(); reject(new Error('设置已取消')); };
      document.addEventListener('mouseover', move, true);
      document.addEventListener('click', click, true);
      document.addEventListener('keydown', key, true);
    });
  }
  let settingUp = false;
  async function setup() {
    if (settingUp) throw new Error('正在设置，请先完成或取消');
    stop(); config = null; settingUp = true;
    try {
      const header = await pick('1/5：点选聊天窗口顶部的对方昵称（不要选择会话列表中的昵称）。');
      const incoming = await pick('2/5：点选对方发来的一条文本消息文字。');
      const outgoing = await pick('3/5：点选自己发过的一条文本消息文字，用于区分消息方向。');
      if (!textOf(incoming) || !textOf(outgoing) || incoming === outgoing || incoming.contains(outgoing) || outgoing.contains(incoming)) throw new Error('请分别选择一条收件和一条发件');
      const root = DouyinMessageRecognition.commonParent(incoming, outgoing);
      const { selector, ownSelector, appearance } = DouyinMessageRecognition.inferPair(incoming, outgoing, root);
      const selectedInput = await pick('4/5：点选消息输入框。');
      const input = selectedInput.closest('textarea, input, [contenteditable="true"]');
      if (!input) throw new Error('选中的元素不是文本输入框，请重新设置');
      const selectedSend = await pick('5/5：点选发送按钮（本次点击不会发送）。');
      let send = selectedSend.closest('button, [role="button"], a[href], [tabindex="0"]');
      if (!send) {
        for (let node = selectedSend; node && node !== document.body; node = node.parentElement) {
          if (getComputedStyle(node).cursor === 'pointer') { send = node; break; }
        }
      }
      send ||= selectedSend;
      if (send === input || send.contains(input) || root.contains(input) || header.contains(root) || !textOf(header)) throw new Error('选择范围过大或不正确，请重新设置');
      config = { header, root, input, send, selector, ownSelector, appearance, title: textOf(header), url: location.href };
      report(`设置完成：${config.title}${appearance ? '（已按气泡颜色和位置识别收发方向）' : ''}。请打开扩展先试运行，并让对方发送一条新消息。`);
    } catch (error) { report(error.message); }
    finally { settingUp = false; }
  }
  function inputText() { return DouyinComposer.read(config.input); }
  function draftMessage() {
    const draft = inputText().trim();
    return `程序读到未发送内容：「${draft.slice(0, 50)}${draft.length > 50 ? '…' : ''}」。已暂停，请先发送或清除这段内容；如果输入框看起来为空，请反馈这段提示。`;
  }
  function fillInput(value) {
    const input = config.input;
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = getSelection(), range = document.createRange();
      range.selectNodeContents(input); selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, value)) throw new Error('无法填写此输入框，已停止');
    }
  }
  function clickSend() {
    const send = config.send;
    if (typeof send.click === 'function') send.click();
    else send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window }));
  }
  function readMessages() {
    return DouyinMessageRecognition.collect(config.root, config.selector, config.ownSelector, config.appearance);
  }
  function snapshot() {
    const { incoming, outgoing } = readMessages();
    const incomingSet = new Set(incoming);
    return [...incoming, ...outgoing].sort((a, b) => {
      const first = a.getBoundingClientRect(), second = b.getBoundingClientRect();
      if (Math.abs(first.top - second.top) > 1) return first.top - second.top;
      if (Math.abs(first.left - second.left) > 1) return first.left - second.left;
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    })
      .map(node => ({ node, role: incomingSet.has(node) ? 'user' : 'assistant', content: DouyinMessageRecognition.messageText(node) }))
      .filter(item => item.content);
  }
  function messagePreview(content) {
    const compact = String(content || '').replace(/\s+/g, ' ').trim();
    return compact ? compact.slice(0, 160) + (compact.length > 160 ? '…' : '') : '暂无可识别的对方文本消息';
  }
  function latestIncoming(items = snapshot()) {
    return messagePreview(items.filter(item => item.role === 'user').at(-1)?.content);
  }
  function findHistoryScroller() {
    let fallback;
    for (let node = config.root; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.clientHeight < 40 || !/^(auto|scroll|overlay|hidden)$/.test(style.overflowY)) continue;
      if (node.scrollHeight - node.clientHeight > 1) return node;
      if (style.overflowY !== 'hidden') fallback ||= node;
    }
    return fallback || null;
  }
  function historyPosition(scroller) {
    const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const style = getComputedStyle(scroller);
    const reverse = scroller.scrollTop < -1 || (/flex/.test(style.display) && style.flexDirection === 'column-reverse');
    const oldest = reverse ? -range : 0;
    const newest = reverse ? 0 : range;
    return { oldest, newest, top: scroller.scrollTop, remaining: Math.max(0, scroller.scrollTop - oldest) };
  }
  async function checkLearningBackend() {
    let response;
    try { response = await chrome.runtime.sendMessage({ type: 'ai:capabilities', clientVersion: VERSION }); }
    catch { throw new Error('无法连接扩展后台。请在 Edge 扩展管理页重新加载扩展，再刷新抖音页面。'); }
    if (response?.code === 'AI_SOURCE_REJECTED') throw new Error(response.error);
    if (response?.backendVersion !== VERSION || response?.installedVersion !== VERSION || !response?.capabilities?.includes('distill')) {
      throw new Error(`学习功能尚未就绪：页面 ${VERSION}，后台 ${response?.backendVersion || '旧版或无法确认'}。请完整覆盖新版扩展文件，在 Edge 扩展管理页点击“重新加载”，再刷新抖音页面。`);
    }
  }
  async function distillStyle() {
    if (busy || settingUp) throw new Error('正在处理消息或设置，请稍后再试');
    if (!validContext()) throw new Error('请先完成网页元素设置；页面或会话变化后需要重设');
    stop('正在准备读取历史聊天…');
    busy = true;
    const learningEpoch = epoch;
    const checkLearningContext = () => {
      if (epoch !== learningEpoch) throw new Error('学习已取消');
      if (!validContext()) throw new Error('学习期间会话或页面发生变化，请重新设置');
    };
    const samples = [], known = new Set();
    let characters = 0, truncated = false;
    let historyState = '', historyChangedAt = Date.now();
    const capture = () => {
      const items = snapshot();
      const state = JSON.stringify(items.map(item => [item.role, item.content]));
      if (state !== historyState) { historyState = state; historyChangedAt = Date.now(); }
      for (const item of items) {
        if (item.role !== 'assistant') continue;
        const text = item.content.trim();
        if (!text || known.has(text)) continue;
        if (samples.length >= 500 || characters + text.length > 60000) { truncated = true; break; }
        known.add(text); samples.push(text); characters += text.length;
      }
    };
    const scroller = findHistoryScroller();
    const bottomGap = scroller ? historyPosition(scroller).newest - scroller.scrollTop : 0;
    const originalBehavior = scroller?.style.getPropertyValue('scroll-behavior');
    const originalPriority = scroller?.style.getPropertyPriority('scroll-behavior');
    let movedPixels = 0, rounds = 0, historyNote = '';
    try {
      await checkLearningBackend();
      checkLearningContext();
      capture();
      if (!scroller) throw new Error(`未找到聊天记录的滚动区域，仅识别到 ${samples.length} 条己方文本，尚未提交学习。请确认聊天气泡区域能向上滚动，再重新点选消息文字。`);
      scroller.style.setProperty('scroll-behavior', 'auto', 'important');
      const startedAt = Date.now();
      let topSince = 0, stuck = 0, previousHeight = scroller.scrollHeight;
      while (!truncated && rounds < 120 && Date.now() - startedAt < 120000) {
        checkLearningContext();
        if (!scroller.isConnected) throw new Error('读取过程中滚动区域被替换，请重新设置后再学习');
        const before = historyPosition(scroller);
        const step = Math.max(40, scroller.clientHeight * .7);
        scroller.scrollTop = Math.max(before.oldest, before.top - step);
        const movement = Math.abs(scroller.scrollTop - before.top);
        movedPixels += movement;
        rounds++;
        // Notify page listeners even if already at the top, where loading may be pending.
        scroller.dispatchEvent(new Event('scroll'));
        if (before.remaining > 1 && movement < 1) stuck++;
        else stuck = 0;
        if (stuck >= 3) throw new Error(`聊天区域未能向上滚动，已停止采集（${samples.length} 条样本），尚未提交学习。请手动向上滚动聊天记录后重新设置。`);
        report(`正在向上读取历史聊天…\n第 ${rounds} 次检查，累计滚动 ${Math.round(movedPixels)} 像素。\n已识别你发出的 ${samples.length} 条不同文本。`);
        await pause(650);
        checkLearningContext();
        capture();
        if (scroller.scrollHeight !== previousHeight) { historyChangedAt = Date.now(); previousHeight = scroller.scrollHeight; }
        if (historyPosition(scroller).remaining <= 1) {
          topSince ||= Date.now();
          report(`已到当前加载记录的顶部，正在等待更早消息…\n累计滚动 ${Math.round(movedPixels)} 像素，已识别 ${samples.length} 条己方文本。`);
          if (Date.now() - Math.max(topSince, historyChangedAt) >= 5000) {
            historyNote = '已到当前加载记录顶部，等待 5 秒未出现更多记录；不代表平台全部历史';
            break;
          }
        } else {
          topSince = 0;
        }
      }
      if (!historyNote) {
        truncated = true;
        historyNote = samples.length >= 500 || characters >= 60000 ? '已达到样本采集上限，仅学习已读取部分' : '已达到本次采集次数、时间或文本预算上限，仅学习已读取部分';
      }
      if (samples.length < 3) throw new Error(`只识别到你发出的 ${samples.length} 条不同文本，至少需要 3 条才能学习风格`);
      report(`已读取 ${samples.length} 条不同文本，MiMo 正在蒸馏聊天风格…\n${historyNote}`);
      checkLearningContext();
      const response = await chrome.runtime.sendMessage({ type: 'ai:distill', samples, clientVersion: VERSION });
      checkLearningContext();
      if (response?.error) throw new Error(response.error);
      if (typeof response?.style !== 'string' || !response.style.trim()) throw new Error('MiMo 没有返回可用的风格摘要');
      report(`聊天风格学习完成：${samples.length} 条样本，累计向上滚动 ${Math.round(movedPixels)} 像素。\n${historyNote}。请在扩展中检查结果。`);
      return { status, style: response.style.trim(), sampleCount: samples.length, truncated, historyNote, movedPixels: Math.round(movedPixels) };
    } catch (error) {
      if (epoch === learningEpoch) report('学习停止：' + error.message);
      throw error;
    } finally {
      if (scroller) {
        if (scroller.isConnected && epoch === learningEpoch && validContext()) {
          const position = historyPosition(scroller);
          scroller.scrollTop = Math.max(position.oldest, position.newest - bottomGap);
        }
        if (originalBehavior) scroller.style.setProperty('scroll-behavior', originalBehavior, originalPriority);
        else scroller.style.removeProperty('scroll-behavior');
      }
      busy = false;
    }
  }
  function unchanged(before) {
    const after = snapshot();
    return before.length === after.length && before.every((item, i) => item.node === after[i].node && item.content === after[i].content && item.role === after[i].role);
  }
  async function tick() {
    if (!running || busy) return;
    busy = true;
    const run = epoch;
    try {
      if (!validContext()) return stop('聊天窗口或页面已改变，已停止。请重新设置。');
      if (inputText().trim()) return stop(draftMessage());
      const now = Date.now();
      const current = snapshot();
      const messages = current.filter(item => item.role === 'user').map(item => item.node);
      const messageSet = new Set(messages);
      // A bubble can remain in the DOM while its text becomes a loaded sticker.
      // Reconcile this just like a replaced list instead of treating it as fatal.
      const reloaded = anchors.some(n => !messageSet.has(n));
      if (reloaded) {
        pending.clear();
        const boundary = DouyinMessageRecognition.reconcileTimeline(timeline, current);
        seen = new WeakSet();
        if (boundary === null) {
          for (const node of messages) seen.add(node);
          anchors = messages;
          timeline = current;
          report(`消息列表已刷新，无法确认新旧边界；已安全跳过当前内容并继续等待新消息。\n识别到对方最新消息：${latestIncoming(current)}`);
          return;
        }
        for (const item of current.slice(0, boundary)) if (item.role === 'user') seen.add(item.node);
        report(`消息列表已刷新，已重新对齐聊天记录并继续运行。\n识别到对方最新消息：${latestIncoming(current)}`);
      }
      const lastAnchor = anchors.at(-1);
      if (!reloaded && lastAnchor) {
        const boundary = messages.indexOf(lastAnchor);
        if (boundary < 0) return stop('原有消息的识别方式发生变化，已暂停，请重新设置。');
        // Newly materialized bubbles before the known tail are backfilled
        // history. Keep them as context, without queuing a reply or stopping.
        for (const node of messages.slice(0, boundary)) {
          if (!pending.has(node)) seen.add(node);
        }
      }
      if (messages.length > 500) return stop('当前会话消息较多，请重新打开会话并设置。');
      let newestDetected = '';
      for (const node of messages) {
        if (seen.has(node) || !visible(node)) continue;
        const text = DouyinMessageRecognition.messageText(node);
        if (!text) continue;
        if (!pending.has(node)) { pending.set(node, { text, since: now }); newestDetected = text; }
        else if (pending.get(node).text !== text) { pending.set(node, { text, since: now }); newestDetected = text; }
      }
      anchors = messages;
      timeline = current;
      for (const [node] of pending) if (!messageSet.has(node)) pending.delete(node);
      if (newestDetected) report(`识别到对方新消息：${messagePreview(newestDetected)}\n等待对方连续消息合并后生成回复…`);
      if (!pending.size || [...pending.values()].some(entry => now - entry.since < 3000) || now - lastReply < interval) return;
      const before = snapshot();
      if (before.at(-1)?.role !== 'user') {
        for (const [node] of pending) seen.add(node);
        pending.clear();
        report('已检测到你的回复，跳过此前待回复消息，继续等待新的文字消息。');
        return;
      }
      const batch = [...pending];
      {
        lastReply = now;
        report(`AI 正在理解 ${config.title} 的消息并生成回复…`);
        const response = await chrome.runtime.sendMessage({ type: 'ai:reply', history: before.slice(-24).map(({ role, content }) => ({ role, content: content.slice(-8000) })) });
        if (!running || epoch !== run) return;
        if (!running || !validContext()) return stop('会话已改变，已停止。');
        if (response?.error) throw new Error(response.error);
        const reply = response?.reply;
        if (typeof reply !== 'string' || !reply.trim() || reply.length > 500) throw new Error('AI 返回的回复不可发送');
        if (!unchanged(before)) { report('对话有新变化，已丢弃旧回复，稍后结合最新消息重新生成。'); return; }
        if (inputText().trim()) return stop(draftMessage());
        for (const [node] of batch) { pending.delete(node); seen.add(node); }
        if (preview) {
          fillInput(reply);
          await pause(150);
          if (!running || epoch !== run) return;
          if (inputText().trim() !== reply) return stop('试运行生成成功，但无法写入输入框。请重新点选输入框。');
          running = false;
          clearInterval(timer);
          pending.clear();
          report(`AI 试运行 · ${config.title}\n已填入输入框：${reply}\n未发送。你可以修改、手动发送或清除。`);
          return;
        }
        const previousOutgoing = new Set(readMessages().outgoing);
        fillInput(reply);
        await pause(350);
        if (!running || epoch !== run) return;
        if (!validContext() || !unchanged(before)) return stop('发送前会话状态改变，已停止。请检查输入框。');
        if (inputText().trim() !== reply || config.send.disabled || config.send.getAttribute('aria-disabled') === 'true') return stop('输入或发送按钮状态异常，已停止。请检查输入框。');
        clickSend();
        let confirmed = false;
        for (let i = 0; i < 20; i++) {
          await pause(250);
          if (!running || !validContext()) break;
          if (!inputText().trim() && readMessages().outgoing.some(n => !previousOutgoing.has(n) && textOf(n).includes(reply))) { confirmed = true; break; }
        }
        if (!running || epoch !== run) return;
        if (!confirmed) return stop('无法确认消息是否发出，已停止，不会自动重试。请在聊天窗口核对。');
        report(`自动回复中 · ${config.title}\n已在网页中看到回复：${reply}`);
      }
    } catch (error) { if (running && epoch === run) stop('运行停止：' + error.message); }
    finally { busy = false; }
  }
  function start(message) {
    if (busy) throw new Error('正在处理上一条消息，请稍后再试');
    stop();
    if (!validContext()) throw new Error('请先完成网页元素设置；页面或会话变化后需要重设');
    if (!Number.isFinite(message.interval) || message.interval < 10 || message.interval > 3600) throw new Error('间隔必须在 10 至 3600 秒之间');
    if (inputText().trim()) throw new Error(draftMessage());
    interval = message.interval * 1000; preview = message.type === 'preview';
    timeline = snapshot();
    anchors = timeline.filter(item => item.role === 'user').map(item => item.node);
    seen = new WeakSet(anchors);
    pending.clear(); lastReply = 0; running = true;
    report(`${preview ? '试运行已开启，不会发送' : '自动回复已开启'} · ${config.title}\n识别到对方最新消息：${latestIncoming(timeline)}\n等待新的文本消息。`);
    timer = setInterval(tick, 1000);
  }
  const runtimeListener = (message, sender, respond) => {
    try {
      if (message.type === 'distill') {
        distillStyle().then(respond, error => respond({ error: error.message, status }));
        return true;
      }
      if (message.type === 'setup') {
        if (settingUp || busy) throw new Error('正在设置或处理消息，请稍后再试');
        setup();
      } else if (message.type === 'start' || message.type === 'preview') start(message);
      else if (message.type === 'stop') stop();
      respond({ status });
    } catch (error) { respond({ error: error.message }); }
  };
  chrome.runtime.onMessage.addListener(runtimeListener);
  lifecycle.dispose = () => {
    running = false;
    clearInterval(timer);
    pending.clear();
    if (cancelPicker) cancelPicker();
    chrome.runtime.onMessage.removeListener?.(runtimeListener);
    host.remove();
  };
})();
