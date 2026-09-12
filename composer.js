(() => {
  const clean = text => text.replace(/[\u200b\ufeff]/g, '').replace(/\u00a0/g, ' ');
  function read(input) {
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) return input.value;
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const style = getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return '';
      if (node !== input) {
        if (node.matches('[data-slate-placeholder], [data-lexical-placeholder], [data-placeholder="true"], .public-DraftEditorPlaceholder-root, .ProseMirror-placeholder')) return '';
        // Generic placeholder hints are ignored only when explicitly marked and
        // non-editable. A user's literal "发送消息" remains a real draft.
        if (node.hasAttribute('data-placeholder') && node.getAttribute('contenteditable') === 'false' && node.textContent.trim() === node.getAttribute('data-placeholder')) return '';
        if (node.matches('button, [role="button"]')) return '';
      }
      if (node.tagName === 'BR') return '\n';
      if (node.matches('img, video, audio, canvas, svg')) return '[图片或表情草稿]';
      const text = [...node.childNodes].map(visit).join('');
      return node !== input && ['block', 'list-item'].includes(style.display) ? '\n' + text + '\n' : text;
    }
    return clean(visit(input)).trim();
  }
  globalThis.DouyinComposer = { read };
})();
