(() => {
  function messageText(node) {
    const clean = value => value.replace(/[\u200b\ufeff]/g, '').trim();
    const generic = /^(?:\[|【)?(?:表情包?|动画表情|图片|贴纸|GIF)(?:\]|】)?$/i;
    let text = clean(node.innerText ?? node.textContent ?? '');
    const media = node.matches('img,video,audio,canvas,svg') || node.querySelector('img,video,audio,canvas,svg');
    if (media) {
      const nativeNames = new Set(['微笑','大笑','笑哭','捂脸','比心','赞','点赞','尬笑','流泪','害羞','爱心','发怒','惊讶','呲牙','偷笑','可爱','调皮','委屈','色','抱抱','鼓掌','泪奔','得意','发呆','灵机一动','看','耶','OK','疑问','机智','再见']);
      function read(current) {
        if (current.nodeType === Node.TEXT_NODE) return current.nodeValue;
        if (current.nodeType !== Node.ELEMENT_NODE) return '';
        const style = getComputedStyle(current);
        if (current.hidden || style.display === 'none' || style.visibility === 'hidden') return '';
        if (current.matches('img')) {
          const explicit = clean(current.getAttribute('data-emoji-name') || '');
          const label = explicit || clean(current.getAttribute('alt') || '');
          if (!label || generic.test(label) || label.length > 32) return '';
          if (/^(?:\[[^\[\]\r\n]{1,20}\]|【[^【】\r\n]{1,20}】)$/.test(label)) return label;
          if (explicit || nativeNames.has(label)) return '[' + label + ']';
          if (/\p{Extended_Pictographic}/u.test(label) && /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]+$/u.test(label)) return label;
          return '';
        }
        if (current.matches('video,audio,canvas,svg')) return '';
        if (current.tagName === 'BR') return '\n';
        const content = [...current.childNodes].map(read).join('');
        return current !== node && ['block', 'list-item'].includes(style.display) ? '\n' + content + '\n' : content;
      }
      text = clean(read(node));
      // Generic attachment labels are not the content of a sticker.
      if (generic.test(text)) return '';
    }
    return text;
  }
  function commonParent(a, b) {
    if (!a.isConnected || !b.isConnected) throw new Error('点选期间消息区域被网页更新了，请选择同时可见的两条消息');
    let node = a.parentElement;
    while (node && !node.contains(b)) node = node.parentElement;
    if (!node || node === document.body || node === document.documentElement) throw new Error('选中的内容没有共同的聊天容器，请选择同一聊天窗口内的消息正文');
    return node;
  }
  function token(node) {
    let result = node.tagName.toLowerCase() + [...node.classList].map(c => '.' + CSS.escape(c)).join('');
    // Use explicit direction attributes when a page shares CSS classes for both sides.
    for (const name of ['data-is-self', 'data-is-me', 'data-direction', 'data-message-direction', 'data-sender-type', 'data-is-sender', 'align']) {
      if (node.hasAttribute(name)) result += '[' + name + '="' + CSS.escape(node.getAttribute(name)) + '"]';
    }
    return result;
  }
  const overlaps = (a, b) => a === b || a.contains(b) || b.contains(a);
  function candidates(sample, opposite, root) {
    const ancestors = [];
    for (let node = sample; node && node !== root; node = node.parentElement) ancestors.push(node);
    const result = [];
    // Always include the entire path inside the selected chat container. A short
    // selector such as span.text can also match nested text in the other side.
    for (let leaf = 0; leaf < ancestors.length; leaf++) {
      const selector = ':scope > ' + ancestors.slice(leaf).reverse().map(token).join(' > ');
      const nodes = [...root.querySelectorAll(selector)];
      if (nodes.some(n => n === sample || n.contains(sample)) && nodes.every(n => !overlaps(n, opposite))) result.push({ selector, nodes });
    }
    return result;
  }
  function background(node) {
    const color = getComputedStyle(node).backgroundColor;
    return !color || color === 'transparent' || /rgba\([^)]*,\s*0\s*\)$/.test(color) ? null : color;
  }
  function bubbleSamples(sample, root) {
    const bounds = root.getBoundingClientRect(), result = [];
    for (let node = sample; node && node !== root; node = node.parentElement) {
      const rect = node.getBoundingClientRect(), color = background(node);
      if (color && color !== background(root) && rect.width > 2 && rect.height > 2 && rect.width < bounds.width * .97) result.push({ node, color, rect });
    }
    return result;
  }
  function collectAppearance(root, appearance) {
    const bounds = root.getBoundingClientRect();
    if (bounds.width < 100) throw new Error('聊天区域不可见或过窄，已停止');
    const all = root.querySelectorAll('*');
    if (all.length > 6000) throw new Error('聊天区域内容过多，请重新打开聊天窗口后设置');
    const groups = { incoming: [], outgoing: [] };
    const tolerance = Math.max(20, Math.min(36, bounds.width * .04));
    for (const node of all) {
      const color = background(node);
      const side = color === appearance.incoming.color ? 'incoming' : color === appearance.outgoing.color ? 'outgoing' : null;
      if (!side) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2 || rect.width >= bounds.width * .97) continue;
      if (!messageText(node) || node.matches('button,input,textarea,[contenteditable="true"]') || node.querySelector('button,input,textarea,[contenteditable="true"],video,canvas')) continue;
      const inset = side === 'incoming' ? rect.left - bounds.left : bounds.right - rect.right;
      if (Math.abs(inset - appearance[side].inset) <= tolerance) groups[side].push(node);
    }
    // Nested text spans may repeat the bubble's background. Keep one outer bubble.
    for (const side of ['incoming', 'outgoing']) groups[side] = groups[side].filter(node => !groups[side].some(other => other !== node && other.contains(node)));
    return groups;
  }
  function inferAppearance(incoming, outgoing, root) {
    const bounds = root.getBoundingClientRect();
    if (bounds.width < 100) return null;
    for (const a of bubbleSamples(incoming, root)) for (const b of bubbleSamples(outgoing, root)) {
      if (a.color === b.color || overlaps(a.node, b.node)) continue;
      const leftInset = a.rect.left - bounds.left, rightInset = bounds.right - b.rect.right;
      // Calibrate bubble edges, not text centers: long incoming text may cross
      // the middle of the chat while still belonging to the left-hand speaker.
      if (leftInset < -2 || rightInset < -2 || leftInset > bounds.width * .3 || rightInset > bounds.width * .3 || b.rect.right - a.rect.left < bounds.width * .35) continue;
      const appearance = { incoming: { color: a.color, inset: leftInset }, outgoing: { color: b.color, inset: rightInset } };
      const detected = collectAppearance(root, appearance);
      if (detected.incoming.some(n => n.contains(incoming)) && detected.outgoing.some(n => n.contains(outgoing)) && !detected.incoming.some(x => detected.outgoing.some(y => overlaps(x, y)))) return appearance;
    }
    return null;
  }
  function collect(root, selector, ownSelector, appearance) {
    const detected = appearance ? collectAppearance(root, appearance) : {
      incoming: [...root.querySelectorAll(selector)], outgoing: [...root.querySelectorAll(ownSelector)]
    };
    const incoming = detected.incoming.filter(node => messageText(node));
    const outgoing = detected.outgoing.filter(node => messageText(node));
    if (incoming.some(a => outgoing.some(b => overlaps(a, b)))) throw new Error('页面消息结构发生变化，收发方向无法区分，已停止');
    return { incoming, outgoing };
  }
  function inferPair(incoming, outgoing, root) {
    const left = candidates(incoming, outgoing, root);
    const right = candidates(outgoing, incoming, root);
    for (const a of left) for (const b of right) {
      if (!a.nodes.some(x => b.nodes.some(y => overlaps(x, y)))) return { selector: a.selector, ownSelector: b.selector };
    }
    const appearance = inferAppearance(incoming, outgoing, root);
    if (appearance) return { appearance };
    throw new Error('暂未识别到可区分的消息气泡。请点选左侧灰色气泡和右侧蓝色气泡的正文；若仍失败，需要检查实际页面结构。');
  }
  const signature = item => item.role + '\u0000' + item.content;
  function reconcileTimeline(previous, current) {
    if (!previous.length) return 0;
    const old = previous.map(signature), now = current.map(signature);
    for (let length = Math.min(old.length, now.length, 16); length >= 1; length--) {
      const suffix = old.slice(-length), matches = [];
      for (let start = 0; start <= now.length - length; start++) {
        if (suffix.every((value, offset) => value === now[start + offset])) matches.push(start);
      }
      if (matches.length === 1) return matches[0] + length;
    }
    return null;
  }
  globalThis.DouyinMessageRecognition = { commonParent, inferPair, collect, reconcileTimeline, messageText };
})();
