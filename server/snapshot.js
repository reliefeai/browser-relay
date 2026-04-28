/**
 * DOM-to-text extraction function.
 * This JS string is sent to the browser via Runtime.evaluate and returns
 * a text representation of the visible page suitable for an LLM.
 */
export const SNAPSHOT_JS = `
(function() {
  const INTERACTIVE_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
  ]);
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'TEMPLATE',
    'IFRAME', 'OBJECT', 'EMBED',
  ]);
  const BLOCK_TAGS = new Set([
    'DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'LI', 'TABLE', 'TR', 'SECTION', 'ARTICLE',
    'NAV', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'FORM',
    'BLOCKQUOTE', 'PRE', 'HR', 'BR', 'DL', 'DT', 'DD',
    'FIGURE', 'FIGCAPTION', 'ADDRESS',
  ]);

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      var style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (style.position !== 'fixed' && style.position !== 'sticky') return false;
    }
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.hasAttribute('hidden')) return false;
    return true;
  }

  function describeElement(el) {
    var tag = el.tagName;
    if (tag === 'A') {
      var href = el.getAttribute('href') || '';
      var text = (el.innerText || '').trim().slice(0, 120);
      return '[link' + (text ? ' "' + text + '"' : '') + (href ? ' href="' + href + '"' : '') + ']';
    }
    if (tag === 'BUTTON' || (el.getAttribute('role') === 'button')) {
      var text = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80);
      return '[button' + (text ? ' "' + text + '"' : '') + ']';
    }
    if (tag === 'INPUT') {
      var type = el.getAttribute('type') || 'text';
      var name = el.getAttribute('name') || '';
      var placeholder = el.getAttribute('placeholder') || '';
      var label = el.getAttribute('aria-label') || '';
      var val = (el.value || '').slice(0, 80);
      var desc = '[input type=' + type;
      if (name) desc += ' name="' + name + '"';
      if (placeholder) desc += ' placeholder="' + placeholder + '"';
      if (label) desc += ' label="' + label + '"';
      if (val) desc += ' value="' + val + '"';
      desc += ']';
      return desc;
    }
    if (tag === 'TEXTAREA') {
      var name = el.getAttribute('name') || '';
      var placeholder = el.getAttribute('placeholder') || '';
      var val = (el.value || '').slice(0, 200);
      var desc = '[textarea';
      if (name) desc += ' name="' + name + '"';
      if (placeholder) desc += ' placeholder="' + placeholder + '"';
      if (val) desc += ' value="' + val + '"';
      desc += ']';
      return desc;
    }
    if (tag === 'SELECT') {
      var name = el.getAttribute('name') || '';
      var selected = el.options && el.selectedIndex >= 0 ? (el.options[el.selectedIndex].text || '').slice(0, 60) : '';
      var desc = '[select';
      if (name) desc += ' name="' + name + '"';
      if (selected) desc += ' selected="' + selected + '"';
      desc += ']';
      return desc;
    }
    if (tag === 'IMG') {
      var alt = el.getAttribute('alt') || '';
      return alt ? '[image "' + alt.slice(0, 100) + '"]' : '[image]';
    }
    return null;
  }

  var lines = [];
  var maxLen = (typeof __maxLength !== 'undefined') ? __maxLength : 100000;
  var totalLen = 0;
  var truncated = false;

  function addLine(text, indent) {
    if (truncated) return;
    var line = '  '.repeat(indent) + text;
    totalLen += line.length + 1;
    if (totalLen > maxLen) { truncated = true; return; }
    lines.push(line);
  }

  function walk(node, depth) {
    if (truncated) return;
    if (node.nodeType === 3) {
      var text = node.textContent.trim();
      if (text) addLine(text, depth);
      return;
    }
    if (node.nodeType !== 1) return;
    var el = node;
    var tag = el.tagName;
    if (SKIP_TAGS.has(tag)) return;
    if (!isVisible(el)) return;

    var headingMatch = tag.match(/^H([1-6])$/);
    if (headingMatch) {
      var text = (el.innerText || '').trim().slice(0, 200);
      if (text) addLine('#'.repeat(parseInt(headingMatch[1])) + ' ' + text, depth);
      return;
    }

    var desc = describeElement(el);
    if (desc) {
      addLine(desc, depth);
      if (tag === 'A' || tag === 'BUTTON') return;
    }

    var isBlock = BLOCK_TAGS.has(tag);
    var childDepth = desc ? depth + 1 : (isBlock ? depth : depth);

    if (tag === 'LI') {
      var text = '';
      for (var i = 0; i < el.childNodes.length; i++) {
        var child = el.childNodes[i];
        if (child.nodeType === 3) text += child.textContent;
      }
      text = text.trim();
      if (text) addLine('- ' + text.slice(0, 200), depth);
      for (var i = 0; i < el.children.length; i++) {
        walk(el.children[i], depth + 1);
      }
      return;
    }

    if (tag === 'TR') {
      var cells = [];
      for (var i = 0; i < el.children.length; i++) {
        cells.push((el.children[i].innerText || '').trim().slice(0, 100));
      }
      if (cells.some(function(c) { return c; })) {
        addLine('| ' + cells.join(' | ') + ' |', depth);
      }
      return;
    }

    for (var i = 0; i < el.childNodes.length; i++) {
      walk(el.childNodes[i], childDepth);
    }
  }

  walk(document.body, 0);
  return JSON.stringify({ snapshot: lines.join('\\n'), truncated: truncated });
})()
`;
