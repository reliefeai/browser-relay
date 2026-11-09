import { createTaskQueue, TaskError, checkCancelled, pause } from "./tasks.js";
import { observationRecords, textPage } from "./observations.js";
import { createSessions } from "./sessions.js";
import { PROTOCOL_VERSION, FEATURES } from "./protocol.js";

const valueOf = (v) => v?.value;
const compact = (s, n = 180) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
const integer = (n, fallback, min, max) => {
  if (n === undefined) return fallback;
  if (!Number.isInteger(n) || n < min || n > max)
    throw new TaskError("invalid_request", `Expected integer ${min}–${max}`);
  return n;
};
const fail = (code, message, status) => {
  throw new TaskError(code, message, status);
};
const ACTIONS = new Set([
  "click",
  "double_click",
  "hover",
  "move",
  "drag",
  "type",
  "fill",
  "key",
  "scroll",
  "wait",
  "select",
  "check",
  "navigate",
  "focus",
]);
const NODE_FUNCTION = `function(operation, args) {
  if (!this.isConnected) return {error:'stale_ref'};
  const view = this.ownerDocument.defaultView;
  const element = this.nodeType===1 ? this : this.parentElement;
  const hitTest = (x,y) => {
    let target=element;
    for(;;){
      const root=target.getRootNode();
      const hit=root.elementFromPoint?.(x,y);
      if(!hit || (hit!==target && !target.contains(hit)))return false;
      if(!root.host)return true;
      target=root.host;
    }
  };
  if (operation === 'hitTest') return {hittable:hitTest(args.x,args.y)};
  if (operation === 'prepare') {
    const chain=[];
    for(let n=element;n;n=n.parentElement||n.getRootNode().host)chain.push([n,n.scrollLeft,n.scrollTop]);
    const beforeX=view.scrollX, beforeY=view.scrollY;
    element.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
    const r = element.getBoundingClientRect(), s = view.getComputedStyle(element);
    const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    return {visible, disabled:element.matches(':disabled') || !!element.closest('[aria-disabled="true"]'),
      obscured:!hitTest(r.x+r.width/2,r.y+r.height/2), x:r.x+r.width/2, y:r.y+r.height/2, width:r.width, height:r.height, clientLeft:element.clientLeft, clientTop:element.clientTop,
      scrolled:beforeX!==view.scrollX||beforeY!==view.scrollY||chain.some(([n,x,y])=>n.scrollLeft!==x||n.scrollTop!==y),
      background:view.document.visibilityState==='hidden'};
  }
  if (operation === 'inspect') {
    const r=element.getBoundingClientRect(), s=view.getComputedStyle(element);
    return {visible:r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden',
      enabled:!element.matches(':disabled') && !element.closest('[aria-disabled="true"]'),
      value:this.type==='password'?'[redacted]':this.value, text:(this.innerText||'').slice(0,400)};
  }
  if (operation === 'click') { if(typeof element.click!=='function')return false;element.click(); return true; }
  if (operation === 'scroll') {element.scrollBy({left:args.deltaX||0,top:args.deltaY||0,behavior:'instant'});return {scrollLeft:element.scrollLeft,scrollTop:element.scrollTop};}
  if (operation === 'focus') {
    const editable=this.isContentEditable || this.tagName==='TEXTAREA' || (this.tagName==='INPUT' && ['text','search','email','tel','url','password','number'].includes(this.type));
    if(!editable || this.readOnly) return {error:'not_editable'};
    this.focus();
    const active=this.getRootNode().activeElement;
    if(active!==this && !this.contains(active)) return {error:'focus_failed'};
    if (args.clear) {
      if (typeof this.select==='function') this.select();
      else if (this.isContentEditable) { const r=view.document.createRange(); r.selectNodeContents(this); const s=view.getSelection();s.removeAllRanges();s.addRange(r); }
      else return {error:'not_editable'};
    }
    return true;
  }
  if (operation === 'select') {
    if (this.tagName!=='SELECT') return {error:'not_select'};
    const values=Array.isArray(args.value)?args.value:[args.value];
    if (values.some(v=>!Array.from(this.options).some(o=>o.value===v))) return {error:'option_not_found'};
    if (!this.multiple && values.length>1) return {error:'not_multiple_select'};
    if (Array.from(this.options).some(o=>values.includes(o.value) && (o.disabled||o.parentElement?.tagName==='OPTGROUP'&&o.parentElement.disabled))) return {error:'option_disabled'};
    for (const option of this.options) option.selected=values.includes(option.value);
    this.dispatchEvent(new view.Event('input',{bubbles:true}));this.dispatchEvent(new view.Event('change',{bubbles:true}));
    return {selected:Array.from(this.selectedOptions).map(o=>o.value)};
  }
  if (operation === 'checkState') {
    if (['checkbox','radio'].includes(this.type)) return {checked:this.checked,radio:this.type==='radio'};
    const role=this.getAttribute('role'), checked=this.getAttribute('aria-checked');
    if (!['checkbox','radio','switch'].includes(role)||!['true','false','mixed'].includes(checked)) return {error:'not_checkable'};
    return {checked:checked==='mixed'?null:checked==='true',radio:role==='radio'};
  }
}`;

// A hidden tab can scroll its DOM without activating the Chrome tab/window.
// Resolve the container under the pointer so nested panels keep their meaning.
function scrollAtPoint({ x, y, deltaX = 0, deltaY = 0 }) {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element?.matches('iframe, frame'))
    return { error: 'frame_target_required' };
  const root = document.scrollingElement;
  for (let node = element; node && node !== root; node = node.parentElement || node.getRootNode().host) {
    const style = getComputedStyle(node);
    const scrollY = deltaY && node.scrollHeight > node.clientHeight && /auto|scroll|overlay/.test(style.overflowY);
    const scrollX = deltaX && node.scrollWidth > node.clientWidth && /auto|scroll|overlay/.test(style.overflowX);
    if (scrollX || scrollY) {
      node.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
      return { scrollLeft: node.scrollLeft, scrollTop: node.scrollTop };
    }
  }
  window.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
  return { scrollLeft: window.scrollX, scrollTop: window.scrollY };
}

/** Browser-side executor. Local HTTP and remote hub both reach this instance. */
export function createAutomation({
  send,
  resolveTab,
  createTab,
  closeTab,
  listTabs,
  focusTab,
  runtimeInfo = () => ({}),
  publicTabId = (id) => id,
  onActivity = () => () => {},
}) {
  const states = new Map(),
    children = new Map(),
    queue = createTaskQueue();
  const sessions = createSessions({
    cancelTab: queue.cancelTab,
    cancelSession: queue.cancelSession,
    active: queue.active,
  });
  const heldInputs = new Map();
  const signals = new Map(),
    jobOrigins = new Map(),
    sessionOrigins = new Map();
  function state(tabId) {
    if (!states.has(tabId))
      states.set(tabId, {
        refs: new Map(),
        nodes: new Map(),
        ancestors: new Map(),
        next: 0,
        prefix: crypto.randomUUID().slice(0, 8),
        baselines: new Map(),
        shots: new Map(),
        sessions: new Map(),
        documents: new Map(),
      });
    return states.get(tabId);
  }
  function invalidate(tabId) {
    states.delete(tabId);
  }
  async function cdp(tabId, method, params = {}, sessionId) {
    const signal = signals.get(tabId);
    checkCancelled(signal);
    if (
      signal &&
      ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent"].includes(method)
    ) {
      if (!heldInputs.has(tabId)) heldInputs.set(tabId, new Map());
      const held = heldInputs.get(tabId),
        key =
          method === "Input.dispatchMouseEvent"
            ? `mouse:${params.button}`
            : `key:${params.key}`;
      if (["mousePressed", "keyDown", "rawKeyDown"].includes(params.type))
        held.set(key, { method, params });
    }
    if (!signal) return send(tabId, method, params, sessionId);
    const held = heldInputs.get(tabId);
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(
          new TaskError(
            "task_cancelled",
            "Task cancelled; dispatched input is not replayed",
            409,
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          checkCancelled(signal);
          return send(tabId, method, params, sessionId);
        })
        .then((result) => {
          if (["mouseReleased", "keyUp"].includes(params.type))
            held?.delete(
              method === "Input.dispatchMouseEvent"
                ? `mouse:${params.button}`
                : `key:${params.key}`,
            );
          resolve(result);
        }, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async function releaseInputs(tabId) {
    const held = heldInputs.get(tabId);
    heldInputs.delete(tabId);
    if (!held?.size) return;
    await Promise.allSettled(
      [...held.values()].reverse().map(({ method, params }) => {
        const { text, ...rest } = params;
        return send(tabId, method, {
          ...rest,
          type:
            method === "Input.dispatchMouseEvent" ? "mouseReleased" : "keyUp",
        });
      }),
    );
  }
  async function evaluate(tabId, expression, sessionId) {
    const r = await cdp(
      tabId,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails)
      fail(
        "evaluation_failed",
        r.exceptionDetails.text || "Page evaluation failed",
        422,
      );
    return r.result?.value;
  }
  const metadataExpression = `({url:location.href,title:document.title,viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY,dpr:devicePixelRatio},readyState:document.readyState,background:document.visibilityState==='hidden'})`;
  async function frameSession(tabId, frameId) {
    const st = state(tabId);
    const child = children.get(tabId)?.get(frameId);
    if (child) return child.sessionId;
    if (st.sessions.has(frameId)) return st.sessions.get(frameId);
    const attached = await cdp(tabId, "Target.attachToTarget", {
      targetId: frameId,
      flatten: true,
    });
    st.sessions.set(frameId, attached.sessionId);
    return attached.sessionId;
  }
  async function tree(tabId, includeTarget) {
    const st = state(tabId);
    {
      await cdp(tabId, "Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    }
    const [meta, frames] = await Promise.all([
      evaluate(tabId, metadataExpression),
      cdp(tabId, "Page.getFrameTree"),
    ]);
    const nodes = [],
      warnings = [],
      frameInfo = [];
    const redundantRefs = new Set();
    const rendererDOM = new Map();
    async function urlsFor(sessionId) {
      const key = sessionId || "main";
      if (!rendererDOM.has(key))
        rendererDOM.set(
          key,
          (async () => {
            const result = await cdp(
              tabId,
              "DOMSnapshot.captureSnapshot",
              { computedStyles: [] },
              sessionId,
            );
            const urls = new Map(),
              strings = result.strings;
            for (const doc of result.documents) {
              const base = strings[doc.baseURL] || strings[doc.documentURL];
              for (let i = 0; i < doc.nodes.backendNodeId.length; i++) {
                const attrs = doc.nodes.attributes[i] || [];
                for (let j = 0; j < attrs.length; j += 2)
                  if (strings[attrs[j]] === "href") {
                    try {
                      const url = new URL(strings[attrs[j + 1]], base);
                      if (
                        ["http:", "https:", "mailto:", "tel:"].includes(
                          url.protocol,
                        )
                      )
                        urls.set(doc.nodes.backendNodeId[i], url.href);
                    } catch {}
                  }
              }
            }
            return urls;
          })().catch((error) => {
            warnings.push({
              code: "link_metadata_unavailable",
              message: error.message,
            });
            return new Map();
          }),
        );
      return rendererDOM.get(key);
    }
    const visit = async (entry, parent, forcedSession) => {
      const frameId = entry.frame.id;
      let result,
        sessionId = forcedSession;
      try {
        result = await cdp(
          tabId,
          "Accessibility.getFullAXTree",
          { frameId },
          sessionId,
        );
      } catch (error) {
        try {
          sessionId = await frameSession(tabId, frameId);
          result = await cdp(
            tabId,
            "Accessibility.getFullAXTree",
            {},
            sessionId,
          );
        } catch (inner) {
          warnings.push({
            frameId,
            code: "frame_unavailable",
            message: inner.message,
          });
        }
      }
      frameInfo.push({
        id: frameId,
        parentId: parent,
        url: entry.frame.url,
        sessionId,
      });
      const urls = (result?.nodes || []).some((n) => valueOf(n.role) === "link")
        ? await urlsFor(sessionId)
        : new Map();
      const axNodes = new Map(
        (result?.nodes || []).map((node) => [node.nodeId, node]),
      );
      // CDP returns nodes breadth first. Flatten only after walking childIds,
      // otherwise children of omitted paragraphs move behind later siblings.
      const ordered = [], seen = new Set();
      const walk = (node) => {
        if (!node || seen.has(node.nodeId)) return;
        seen.add(node.nodeId);
        ordered.push(node);
        for (const id of node.childIds || []) walk(axNodes.get(id));
      };
      for (const node of axNodes.values())
        if (!axNodes.has(node.parentId)) walk(node);
      for (const node of axNodes.values()) walk(node);
      for (const node of ordered) {
        const selectedRoot = includeTarget && includeTarget.backendId === node.backendDOMNodeId &&
          frameId === (includeTarget.frameId || frames.frameTree.frame.id);
        if (node.ignored && !selectedRoot) continue;
        const role = valueOf(node.role),
          name = String(valueOf(node.name) || "")
            .replace(/\s+/g, " ")
            .trim()
            .replace(role === "RootWebArea" ? /^[🔵⚪]+\s*/u : /$^/, "");
        if (
          [
            "none",
            "generic",
            "InlineTextBox",
            "LabelText",
            "paragraph",
            "Legend",
            "MenuListPopup",
          ].includes(role) &&
          !name && !selectedRoot
        )
          continue;
        if (role === "InlineTextBox") continue;
        const backendId = node.backendDOMNodeId;
        const key = `${frameId}:${backendId}`;
        const ancestry = [];
        for (
          let parent = axNodes.get(node.parentId), depth = 0;
          parent && depth++ < 100;
          parent = axNodes.get(parent.parentId)
        )
          if (parent.backendDOMNodeId)
            ancestry.push(`${frameId}:${parent.backendDOMNodeId}`);
        st.ancestors.set(key, ancestry);
        let ref;
        if (backendId) {
          ref = st.nodes.get(key);
          if (!ref) {
            ref = `e${st.prefix}_${++st.next}`;
            st.nodes.set(key, ref);
          }
          st.refs.set(ref, { backendId, frameId, sessionId });
        }
        if (role === "StaticText" && ref) {
          let ancestor = axNodes.get(node.parentId),
            depth = 0;
          while (ancestor && depth++ < 100) {
            if (
              ["button", "link", "heading", "option"].includes(
                valueOf(ancestor.role),
              ) &&
              String(valueOf(ancestor.name) || "").replace(/\s+/g, " ").trim() === name
            ) {
              redundantRefs.add(ref);
              break;
            }
            ancestor = axNodes.get(ancestor.parentId);
          }
        }
        const properties = Object.fromEntries(
          (node.properties || [])
            .filter((p) =>
              [
                "disabled",
                "checked",
                "selected",
                "expanded",
                "required",
                "focused",
                "level",
              ].includes(p.name),
            )
            .map((p) => [p.name, valueOf(p.value)]),
        );
        // AX may expose password values depending on browser/platform; never emit them.
        const val =
          role === "textbox" || role === "searchbox"
            ? undefined
            : valueOf(node.value);
        nodes.push({
          ref,
          role,
          name,
          ...(val !== undefined && val !== "" ? { value: val } : {}),
          ...(urls.has(backendId) ? { url: urls.get(backendId) } : {}),
          ...properties,
          frameId,
        });
      }
      for (const child of entry.childFrames || [])
        await visit(child, frameId, sessionId);
    };
    await visit(frames.frameTree);
    for (const child of children.get(tabId)?.values() || []) {
      if (
        child.targetInfo.type !== "iframe" ||
        frameInfo.some((f) => f.id === child.targetInfo.targetId)
      )
        continue;
      try {
        const childTree = await cdp(
          tabId,
          "Page.getFrameTree",
          {},
          child.sessionId,
        );
        await visit(
          childTree.frameTree,
          childTree.frameTree.frame.parentId || frames.frameTree.frame.id,
          child.sessionId,
        );
      } catch (error) {
        warnings.push({
          frameId: child.targetInfo.targetId,
          code: "frame_unavailable",
          message: error.message,
        });
      }
    }
    const active = new Set(nodes.map((n) => n.ref).filter(Boolean));
    for (const [ref, node] of st.refs)
      if (!active.has(ref)) {
        st.refs.delete(ref);
        st.nodes.delete(`${node.frameId}:${node.backendId}`);
        st.ancestors.delete(`${node.frameId}:${node.backendId}`);
      }
    const byRef = new Map(nodes.filter((n) => n.ref).map((n) => [n.ref, n]));
    for (const node of nodes) {
      const backend = st.refs.get(node.ref);
      if (!backend) continue;
      const ancestors = (
        st.ancestors.get(`${node.frameId}:${backend.backendId}`) || []
      )
        .map((key) => byRef.get(st.nodes.get(key)))
        .filter(Boolean);
      if (ancestors[0]) node.parentRef = ancestors[0].ref;
      const scope = ancestors.find(
        (n) =>
          n.name &&
          ["group", "form", "region", "navigation", "dialog"].includes(n.role),
      );
      if (scope) node.within = scope.ref;
    }
    // Each frame has its own AX root. Join it to the embedding element so a
    // main/article subtree includes its frames at their actual document position.
    for (const frame of frameInfo) {
      if (!frame.parentId) continue;
      try {
        const parent = frameInfo.find((f) => f.id === frame.parentId);
        const owner = await cdp(tabId, "DOM.getFrameOwner", { frameId: frame.id }, parent?.sessionId);
        const ownerRef = st.nodes.get(`${frame.parentId}:${owner.backendNodeId}`);
        const root = nodes.find((n) => n.frameId === frame.id && n.role === "RootWebArea");
        if (!ownerRef || !root) throw new Error("Frame has no accessible embedding element or root");
        root.parentRef = ownerRef;
        const ownerKey = `${frame.parentId}:${owner.backendNodeId}`;
        const outerAncestors = [ownerKey, ...(st.ancestors.get(ownerKey) || [])];
        for (const node of nodes) {
          if (node.frameId !== frame.id || !node.ref) continue;
          const key = `${frame.id}:${st.refs.get(node.ref).backendId}`;
          st.ancestors.set(key, [...(st.ancestors.get(key) || []), ...outerAncestors]);
        }
      } catch (error) {
        warnings.push({ frameId: frame.id, code: "frame_unattached", message: error.message });
      }
    }
    st.frames = frameInfo;
    return {
      ...meta,
      nodes,
      redundantRefs,
      frames: frameInfo.map(({ sessionId, ...f }) => f),
      warnings,
    };
  }
  async function awaitPaint(tabId, sessionId) {
    // Input acknowledgement precedes paint/compositor scrolling. Wait for a
    // rendered frame, bounded for background tabs whose rAF can be suspended.
    await evaluate(
      tabId,
      `new Promise(resolve=>{const timer=setTimeout(resolve,100);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));})`,
      sessionId,
    );
  }
  async function observe(tabId, options = {}) {
    if (
      !["snapshot", "read", "both", "screenshot"].includes(
        options.mode || "snapshot",
      )
    )
      fail("invalid_request", "Unknown observation mode");
    const st = state(tabId);
    const maxLength = integer(options.maxLength, 20000, 100, 100000);
    const saveBaseline = (key, value) => {
      if ((st.baselines.get(key)?.capturedAt || 0) > value.capturedAt) return;
      if (st.baselines.size >= 50 && !st.baselines.has(key))
        st.baselines.delete(st.baselines.keys().next().value);
      st.baselines.set(key, value);
    };
    if (options.cursor) {
      const match = /^(obs_[\w-]+):(\d+)$/.exec(String(options.cursor));
      const saved = match && st.documents.get(match[1]);
      if (!saved)
        fail(
          "stale_observation",
          "Observation expired or navigation invalidated it; read the page again",
          409,
        );
      const offset = Number(match[2]);
      if (
        !Number.isSafeInteger(offset) ||
        offset >= saved.text.length ||
        offset > saved.seenThrough
      )
        fail("invalid_cursor", "Invalid observation cursor");
      const page = textPage(saved.text, offset, maxLength);
      saved.seenThrough = Math.max(saved.seenThrough, page.end);
      if (saved.seenThrough === saved.text.length)
        saveBaseline(saved.baselineKey, {
          url: saved.meta.url,
          records: saved.records,
          capturedAt: saved.meta.capturedAt,
        });
      return {
        ...saved.meta,
        ...page,
        observationId: match[1],
        nextCursor: page.truncated ? `${match[1]}:${page.end}` : null,
      };
    }
    await awaitPaint(tabId);
    if (options.mode === "screenshot") return screenshot(tabId, options);
    let root;
    if (options.target) root = await resolveNode(tabId, options.target);
    const data = await tree(tabId, root);
    const capturedAt = Date.now();
    const rootRef = root && st.nodes.get(`${root.frameId || data.frames[0]?.id}:${root.backendId}`);
    if (root && !rootRef)
      fail("stale_ref", "Requested subtree disappeared; observe again", 409);
    const records = observationRecords(data, { mode: options.mode, rootRef });
    const session = String(options.sessionId || "default").slice(0, 128);
    const baselineKey = JSON.stringify([
      session,
      options.mode || "snapshot",
      rootRef || "page",
    ]);
    const previous = st.baselines.get(baselineKey);
    let lines = [...records.values()],
      diff = false;
    if (options.diff === true && previous?.url === data.url) {
      diff = true;
      lines = [];
      for (const [key, line] of previous.records)
        if (!records.has(key)) lines.push(`- ${line}`);
      for (const [key, line] of records)
        if (previous.records.get(key) !== line)
          lines.push(`${previous.records.has(key) ? "~" : "+"} ${line}`);
      if (!lines.length) lines.push("(no changes)");
    }
    const text = lines.join("\n"),
      page = textPage(text, 0, maxLength);
    if (!page.truncated)
      saveBaseline(baselineKey, { url: data.url, records, capturedAt });
    const warnings = [...data.warnings];
    if (data.background)
      warnings.push({
        code: "background_tab",
        message:
          "Background pages may defer rendering. Focus explicitly if content does not advance.",
      });
    if (data.readyState === "loading")
      warnings.push({
        code: "page_loading",
        message:
          "Document is still loading; wait for the expected content before reading it as complete.",
      });
    const observationId = `obs_${crypto.randomUUID()}`;
    const meta = {
      ok: true,
      url: data.url,
      title: data.title,
      viewport: data.viewport,
      readyState: data.readyState,
      background: data.background,
      diff,
      frames: data.frames,
      warnings,
      capturedAt,
      totalCharacters: text.length,
      scope: rootRef || (options.mode === "read" && data.nodes.some((n) => n.role === "main" && n.frameId === data.frames[0]?.id) ? "main" : "page"),
    };
    if (page.truncated && text.length <= 4_000_000) {
      while (st.documents.size >= 3)
        st.documents.delete(st.documents.keys().next().value);
      st.documents.set(observationId, {
        meta,
        text,
        records,
        baselineKey,
        seenThrough: page.end,
      });
    } else if (page.truncated)
      warnings.push({
        code: "observation_too_large",
        message:
          "Read a smaller subtree using target; the page exceeds the continuation cache limit.",
      });
    const result = {
      ...meta,
      ...page,
      observationId,
      nextCursor:
        page.truncated && st.documents.has(observationId)
          ? `${observationId}:${page.end}`
          : null,
      ...(options.includeNodes ? { nodes: data.nodes } : {}),
    };
    if (options.mode === "both")
      result.screenshot = await screenshot(tabId, options);
    return result;
  }
  async function nodeCall(tabId, node, operation, args = {}) {
    let objectId;
    try {
      objectId = (
        await cdp(
          tabId,
          "DOM.resolveNode",
          { backendNodeId: node.backendId },
          node.sessionId,
        )
      ).object.objectId;
      const result = await cdp(
        tabId,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: NODE_FUNCTION,
          arguments: [{ value: operation }, { value: args }],
          returnByValue: true,
        },
        node.sessionId,
      );
      if (result.exceptionDetails)
        fail(
          "element_action_failed",
          result.exceptionDetails.exception?.description ||
            result.exceptionDetails.text ||
            "Element action failed",
          422,
        );
      const value = result.result?.value;
      if (value?.error) fail(value.error, value.error, 409);
      return value;
    } catch (error) {
      if (error.code) throw error;
      fail(
        "stale_ref",
        "Element no longer exists; observe the page again",
        409,
      );
    } finally {
      if (objectId)
        await cdp(
          tabId,
          "Runtime.releaseObject",
          { objectId },
          node.sessionId,
        ).catch(() => {});
    }
  }
  async function resolveNode(tabId, target, depth = 0) {
    if (depth > 5) fail("invalid_target", "Scope nesting is too deep");
    if (typeof target === "string")
      target =
        target.startsWith("e") && /^e[\w]+_\d+$/.test(target)
          ? { ref: target }
          : { selector: target };
    if (!target || typeof target !== "object")
      fail("invalid_target", "Use a ref, selector, or role/name target");
    if (target.scope && !(target.role || target.name))
      fail("invalid_target", "scope requires a role/name target");
    const st = state(tabId);
    if (target.ref) {
      const node = st.refs.get(target.ref);
      if (!node)
        fail(
          "stale_ref",
          "Unknown or expired reference; observe the page again",
          409,
        );
      return node;
    }
    if (target.role || target.name) {
      const scope = target.scope
        ? await resolveNode(tabId, target.scope, depth + 1)
        : null;
      const data = await tree(tabId);
      const matches = data.nodes.filter(
        (n) =>
          n.ref &&
          (!target.frameId || n.frameId === target.frameId) &&
          (!scope ||
            (
              st.ancestors.get(
                `${n.frameId}:${st.refs.get(n.ref)?.backendId}`,
              ) || []
            ).includes(
              `${scope.frameId || data.frames[0]?.id}:${scope.backendId}`,
            )) &&
          (!target.role || n.role === target.role) &&
          (target.name === undefined ||
            (target.exact === false
              ? n.name.includes(target.name)
              : n.name === target.name)),
      );
      if (!matches.length)
        fail("element_not_found", "No matching accessible element", 404);
      if (matches.length !== 1)
        fail(
          "ambiguous_target",
          `Target matches ${matches.length} elements; use a ref, scope, or frameId`,
          409,
        );
      return st.refs.get(matches[0].ref);
    }
    if (typeof target.selector !== "string")
      fail("invalid_target", "selector is required");
    let contextId, sessionId;
    if (target.frameId) {
      try {
        contextId = (
          await cdp(tabId, "Page.createIsolatedWorld", {
            frameId: target.frameId,
            worldName: "browser-relay-locator",
          })
        ).executionContextId;
      } catch {
        sessionId = await frameSession(tabId, target.frameId);
        contextId = (
          await cdp(
            tabId,
            "Page.createIsolatedWorld",
            { frameId: target.frameId, worldName: "browser-relay-locator" },
            sessionId,
          )
        ).executionContextId;
      }
    }
    const expression = `(() => { const found=[]; const walk=root=>{found.push(...root.querySelectorAll(${JSON.stringify(target.selector)}));for(const el of root.querySelectorAll('*'))if(el.shadowRoot)walk(el.shadowRoot);};walk(document);if(found.length!==1)throw new Error('Expected one element; found '+found.length);return found[0];})()`;
    const r = await cdp(
      tabId,
      "Runtime.evaluate",
      { expression, contextId },
      sessionId,
    );
    if (r.exceptionDetails)
      fail(
        "invalid_target",
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
        409,
      );
    try {
      const { node } = await cdp(
        tabId,
        "DOM.describeNode",
        { objectId: r.result.objectId },
        sessionId,
      );
      return {
        backendId: node.backendNodeId,
        frameId: target.frameId,
        sessionId,
      };
    } finally {
      if (r.result?.objectId)
        await cdp(
          tabId,
          "Runtime.releaseObject",
          { objectId: r.result.objectId },
          sessionId,
        ).catch(() => {});
    }
  }
  async function frameOffset(tabId, frameId, point) {
    const st = state(tabId);
    if (!st.frames) await tree(tabId);
    let x = 0,
      y = 0,
      frame = st.frames.find((f) => f.id === frameId);
    while (frame?.parentId) {
      const parent = st.frames.find((f) => f.id === frame.parentId);
      const owner = await cdp(
        tabId,
        "DOM.getFrameOwner",
        { frameId: frame.id },
        parent?.sessionId,
      );
      const rect = await nodeCall(
        tabId,
        { backendId: owner.backendNodeId, sessionId: parent?.sessionId },
        "prepare",
      );
      // A scroll can update DOM geometry before Chromium's compositor routes
      // pointer events to an iframe. Otherwise down/up may hit different frames.
      if (rect.scrolled && !rect.background)
        await awaitPaint(tabId, parent?.sessionId);
      x += rect.x - rect.width / 2 + (rect.clientLeft || 0);
      y += rect.y - rect.height / 2 + (rect.clientTop || 0);
      if (point) {
        const hit = await nodeCall(
          tabId,
          { backendId: owner.backendNodeId, sessionId: parent?.sessionId },
          "hitTest",
          { x: point.x + x, y: point.y + y },
        );
        if (!rect.visible || !hit.hittable)
          fail(
            "element_obscured",
            "Target iframe is clipped or covered at the action point",
            409,
          );
      }
      frame = parent;
    }
    return { x, y };
  }
  async function screenshot(tabId, options = {}) {
    const meta = await evaluate(tabId, metadataExpression);
    let clip = options.clip;
    if (options.fullPage) {
      const metrics = await cdp(tabId, "Page.getLayoutMetrics");
      const size = metrics.cssContentSize || metrics.contentSize;
      clip = {
        x: 0,
        y: 0,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        scale: 1,
      };
    }
    if (clip) {
      for (const k of ["x", "y", "width", "height"])
        if (
          !Number.isFinite(clip[k]) ||
          clip[k] < (k === "x" || k === "y" ? 0 : 1)
        )
          fail("invalid_clip", "Invalid screenshot clip");
      if (clip.width * clip.height > 40_000_000)
        fail(
          "screenshot_too_large",
          "Use a viewport screenshot or a smaller clip",
        );
      clip = { ...clip, scale: 1 };
    }
    const { data } = await cdp(tabId, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: !!clip,
      ...(clip ? { clip } : {}),
    });
    const bytes = atob(data.slice(0, 44)),
      uint = (i) =>
        bytes.charCodeAt(i) * 2 ** 24 +
        (bytes.charCodeAt(i + 1) << 16) +
        (bytes.charCodeAt(i + 2) << 8) +
        bytes.charCodeAt(i + 3);
    const width = uint(16),
      height = uint(20),
      screenshotId = `shot_${crypto.randomUUID()}`;
    const mapping = {
      scaleX: (clip?.width || meta.viewport.width) / width,
      scaleY: (clip?.height || meta.viewport.height) / height,
      offsetX: clip ? clip.x - meta.viewport.scrollX : 0,
      offsetY: clip ? clip.y - meta.viewport.scrollY : 0,
    };
    const shot = {
      ok: true,
      data,
      format: "png",
      width,
      height,
      screenshotId,
      viewport: meta.viewport,
      url: meta.url,
      fullPage: !!options.fullPage,
      imageToViewport: mapping,
    };
    const shots = state(tabId).shots;
    if (shots.size >= 5) shots.delete(shots.keys().next().value);
    shots.set(screenshotId, { ...shot, data: undefined });
    return shot;
  }
  async function point(tabId, action, { allowBackground = false } = {}) {
    let { x, y } = action;
    if (!Number.isFinite(x) || !Number.isFinite(y))
      fail("invalid_coordinates", "Finite x and y are required");
    if (action.screenshotId) {
      const shot = state(tabId).shots.get(action.screenshotId);
      if (!shot)
        fail("stale_screenshot", "Screenshot expired; capture a new one", 409);
      const meta = await evaluate(tabId, metadataExpression);
      if (
        meta.url !== shot.url ||
        JSON.stringify(meta.viewport) !== JSON.stringify(shot.viewport)
      )
        fail(
          "stale_screenshot",
          "Viewport changed; capture a new screenshot",
          409,
        );
      if (x < 0 || y < 0 || x >= shot.width || y >= shot.height)
        fail("invalid_coordinates", "Point is outside screenshot");
      x = x * shot.imageToViewport.scaleX + shot.imageToViewport.offsetX;
      y = y * shot.imageToViewport.scaleY + shot.imageToViewport.offsetY;
    }
    const meta = await evaluate(tabId, metadataExpression);
    if (x < 0 || y < 0 || x >= meta.viewport.width || y >= meta.viewport.height)
      fail(
        "invalid_coordinates",
        "Point is outside current viewport; scroll first",
      );
    if (meta.background && !allowBackground) {
      if (action.allowFocus && focusTab) await focusTab(tabId);
      else
        fail(
          "needs_foreground",
          "Visual input requires a visible tab; use a semantic target in the background. Only focus when the user has requested foreground operation",
          409,
        );
    }
    return { x, y };
  }
  async function key(tabId, combo) {
    const aliases = {
      Return: "Enter",
      Esc: "Escape",
      Up: "ArrowUp",
      Down: "ArrowDown",
      Left: "ArrowLeft",
      Right: "ArrowRight",
      space: " ",
    };
    const parts = combo.split("+"),
      last = parts.pop(),
      k = aliases[last] || last;
    let modifiers = 0;
    for (const part of parts) {
      const m = {
        Control: 2,
        Ctrl: 2,
        Alt: 1,
        Shift: 8,
        Meta: 4,
        Command: 4,
        super: 4,
      }[part];
      if (!m) fail("invalid_key", `Unknown modifier ${part}`);
      modifiers |= m;
    }
    const virtual = {
      Enter: 13,
      Tab: 9,
      Escape: 27,
      Backspace: 8,
      Delete: 46,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Home: 36,
      End: 35,
      PageUp: 33,
      PageDown: 34,
      " ": 32,
    };
    if (k.length !== 1 && !virtual[k])
      fail("invalid_key", `Unsupported key ${k}`);
    const vk = virtual[k] || k.toUpperCase().charCodeAt(0),
      base = {
        key: k,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      };
    await cdp(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      ...base,
      ...(!modifiers && (k.length === 1 || k === "Enter")
        ? { text: k === "Enter" ? "\r" : k }
        : {}),
    });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  async function perform(tabId, action, signal) {
    checkCancelled(signal);
    const type = action.type;
    if (type === "focus") {
      await focusTab(tabId);
      await awaitPaint(tabId);
      return { focused: true };
    }
    if (type === "navigate") {
      const before = await cdp(tabId, "Page.getFrameTree");
      const result = await cdp(tabId, "Page.navigate", { url: action.url });
      if (result.errorText) fail("navigation_failed", result.errorText, 422);
      invalidate(tabId);
      const deadline = Date.now() + (action.timeoutMs || 10000);
      while (result.loaderId && action.waitUntil !== "commit") {
        checkCancelled(signal);
        try {
          const frames = await cdp(tabId, "Page.getFrameTree");
          const meta = await evaluate(tabId, metadataExpression);
          if (
            frames.frameTree.frame.loaderId !==
              before.frameTree.frame.loaderId &&
            meta.readyState !== "loading"
          )
            break;
        } catch (error) {
          if (error.code === "task_cancelled") throw error;
        }
        if (Date.now() >= deadline)
          fail(
            "navigation_timeout",
            "Navigation started but document readiness timed out; inspect current state before continuing",
            408,
          );
        await pause(50, signal);
      }
      return { navigated: true, waitUntil: action.waitUntil || "interactive" };
    }
    if (type === "key") {
      await key(tabId, action.key);
      return { pressed: true };
    }
    if (type === "wait") {
      const deadline = Date.now() + integer(action.timeoutMs, 5000, 1, 20000),
        stateName = action.state || "visible";
      do {
        checkCancelled(signal);
        try {
          const node = await resolveNode(tabId, action.target),
            details = await nodeCall(tabId, node, "inspect");
          if (
            stateName === "attached" ||
            (stateName === "visible" && details.visible) ||
            (stateName === "enabled" && details.visible && details.enabled) ||
            (stateName === "hidden" && !details.visible)
          )
            return { matched: true };
        } catch (error) {
          if (
            ["hidden", "detached"].includes(stateName) &&
            ["element_not_found", "stale_ref"].includes(error.code)
          )
            return { matched: true };
          // CSS missing nodes are distinct from invalid/ambiguous selectors.
          if (
            error.code === "invalid_target" &&
            /found 0\b/.test(error.message)
          ) {
            if (["hidden", "detached"].includes(stateName))
              return { matched: true };
          } else if (!["element_not_found", "stale_ref"].includes(error.code))
            throw error;
        }
        if (Date.now() >= deadline) break;
        await pause(Math.min(100, deadline - Date.now()), signal);
      } while (true);
      fail("wait_timeout", "Target did not reach the requested state", 408);
    }
    let node, rect, targetOffset;
    if (action.target) {
      const deadline = Date.now() + (action.timeoutMs || 0);
      let previousRect;
      for (;;) {
        checkCancelled(signal);
        try {
          node = await resolveNode(tabId, action.target);
          rect = await nodeCall(tabId, node, "prepare");
          if (!rect.visible)
            fail("element_not_visible", "Target is not visible", 409);
          if (rect.disabled)
            fail("element_disabled", "Target is disabled", 409);
          if (rect.obscured && type !== "scroll")
            fail(
              "element_obscured",
              "Target is covered by another element",
              409,
            );
          if (type !== "scroll")
            targetOffset = await frameOffset(tabId, node.frameId, rect);
          if (
            action.timeoutMs &&
            ["click", "double_click", "hover", "drag", "check"].includes(type)
          ) {
            const position = [
              rect.x + targetOffset.x,
              rect.y + targetOffset.y,
              rect.width,
              rect.height,
            ];
            if (
              !previousRect ||
              position.some((n, i) => Math.abs(n - previousRect[i]) > 0.5)
            ) {
              previousRect = position;
              fail("element_unstable", "Target is still moving", 409);
            }
          }
          break;
        } catch (error) {
          const retryable =
            [
              "element_not_found",
              "element_not_visible",
              "element_disabled",
              "element_obscured",
              "element_unstable",
            ].includes(error.code) ||
            (error.code === "invalid_target" &&
              /found 0\b/.test(error.message));
          if (!retryable || Date.now() >= deadline) throw error;
          if (error.code !== "element_unstable") previousRect = undefined;
          await pause(Math.min(50, deadline - Date.now()), signal);
        }
      }
      checkCancelled(signal);
    }
    if (["fill", "type"].includes(type)) {
      if (node)
        await nodeCall(tabId, node, "focus", {
          clear: type === "fill" || action.clear === true,
        });
      else if (type === "fill")
        fail("invalid_target", "fill requires an editable target");
      if (action.text === "") {
        if (node && (type === "fill" || action.clear))
          await key(tabId, "Backspace");
      } else await cdp(tabId, "Input.insertText", { text: action.text });
      if (action.submit) await key(tabId, "Enter");
      return { typed: true };
    }
    if (type === "select") {
      if (!node) fail("invalid_target", `${type} requires a target`);
      return nodeCall(tabId, node, type, action);
    }
    if (type === "check") {
      if (!node) fail("invalid_target", "check requires a target");
      const current = await nodeCall(tabId, node, "checkState");
      if (current.checked === action.checked)
        return { checked: action.checked, changed: false };
      if (current.radio && !action.checked)
        fail(
          "not_checkable",
          "Radio controls cannot be unchecked directly",
          409,
        );
    }
    if (type === "scroll") {
      const before = await evaluate(tabId, metadataExpression);
      const beforeText = action.waitForChange
        ? await evaluate(
            tabId,
            "(document.querySelector('main')||document.body).innerText",
          )
        : undefined;
      if (node) await nodeCall(tabId, node, "scroll", action);
      else if (before.background) {
        const at = await point(tabId, action, { allowBackground: true });
        const result = await evaluate(tabId, `(${scrollAtPoint.toString()})(${JSON.stringify({ ...at, deltaX: action.deltaX || 0, deltaY: action.deltaY || 0 })})`);
        if (result?.error)
          fail(result.error, "Use a target with frameId to scroll inside a background iframe", 409);
      } else {
        // The user may switch tabs during preparation; never reactivate it.
        const at = await point(tabId, { ...action, allowFocus: false });
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          deltaX: action.deltaX || 0,
          deltaY: action.deltaY || 0,
        });
      }
      await awaitPaint(tabId);
      let contentChanged;
      if (action.waitForChange) {
        const deadline = Date.now() + (action.timeoutMs || 1500);
        do {
          contentChanged =
            (await evaluate(
              tabId,
              "(document.querySelector('main')||document.body).innerText",
            )) !== beforeText;
          if (contentChanged || Date.now() >= deadline) break;
          await pause(50, signal);
        } while (true);
      }
      const after = await evaluate(tabId, metadataExpression);
      return {
        scrolled: true,
        strategy: node || before.background ? "dom" : "wheel",
        viewportMoved:
          before.viewport.scrollY !== after.viewport.scrollY ||
          before.viewport.scrollX !== after.viewport.scrollX,
        ...(contentChanged === undefined ? {} : { contentChanged }),
        ...(contentChanged === false
          ? {
              warning:
                before.background
                  ? "No text change observed; background rendering may be deferred or the feed may be at its end. Do not count this as new content."
                  : "No text change observed; the feed may be unchanged or at its end. Do not count this as new content.",
            }
          : {}),
      };
    }
    if (
      node &&
      rect.background &&
      ["click", "check"].includes(type) &&
      (!action.button || action.button === "left")
    ) {
      if (await nodeCall(tabId, node, "click")) {
        if (type === "check") {
          const after = await nodeCall(tabId, node, "checkState");
          if (after.checked !== action.checked)
            fail(
              "checked_state_mismatch",
              "Control did not reach requested checked state",
              409,
            );
          return { checked: after.checked, changed: true, strategy: "dom" };
        }
        return { clicked: true, strategy: "dom" };
      }
    }
    const offset = node
      ? targetOffset || (await frameOffset(tabId, node.frameId, rect))
      : { x: 0, y: 0 };
    const at = await point(
      tabId,
      node
        ? {
            ...action,
            x: rect.x + offset.x,
            y: rect.y + offset.y,
            screenshotId: undefined,
          }
        : action,
    );
    if (type === "move" || type === "hover") {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...at,
      });
      return { moved: true };
    }
    const button = action.button || "left",
      clickCount = type === "double_click" ? 2 : 1;
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
    if (type === "drag") {
      const path = action.path || [action.to],
        end = await point(tabId, {
          ...path.at(-1),
          screenshotId: action.screenshotId,
          allowFocus: action.allowFocus,
        });
      let current = at,
        pressed = false;
      try {
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          ...at,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
        pressed = true;
        for (const dest of path) {
          const goal = await point(tabId, {
            ...dest,
            screenshotId: action.screenshotId,
            allowFocus: action.allowFocus,
          });
          const from = current;
          for (let i = 1; i <= 8; i++) {
            checkCancelled(signal);
            current = {
              x: from.x + ((goal.x - from.x) * i) / 8,
              y: from.y + ((goal.y - from.y) * i) / 8,
            };
            await cdp(tabId, "Input.dispatchMouseEvent", {
              type: "mouseMoved",
              ...current,
              button: "left",
              buttons: 1,
            });
          }
        }
      } finally {
        if (pressed)
          await cdp(tabId, "Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...current,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
      }
      return { dragged: true, end };
    }
    for (let i = 1; i <= clickCount; i++) {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...at,
        button,
        clickCount: i,
      });
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...at,
        button,
        clickCount: i,
      });
    }
    if (type === "check") {
      const after = await nodeCall(tabId, node, "checkState");
      if (after.checked !== action.checked)
        fail(
          "checked_state_mismatch",
          "Control did not reach requested checked state",
          409,
        );
      return { checked: after.checked, changed: true, strategy: "mouse" };
    }
    return { clicked: true, strategy: "mouse" };
  }
  function validate(actions) {
    if (!Array.isArray(actions) || !actions.length || actions.length > 100)
      fail("invalid_request", "actions must contain 1–100 operations");
    for (const action of actions) {
      if (!action || !ACTIONS.has(action.type))
        fail("invalid_action", `Unsupported action: ${action?.type}`);
      if (action.timeoutMs !== undefined)
        integer(action.timeoutMs, 0, 1, 20000);
      if (
        ["type", "fill"].includes(action.type) &&
        typeof action.text !== "string"
      )
        fail("invalid_action", "text is required");
      if (action.type === "key" && typeof action.key !== "string")
        fail("invalid_action", "key is required");
      if (action.type === "navigate") {
        let u;
        try {
          u = new URL(action.url);
        } catch {
          fail("invalid_url", "Invalid URL");
        }
        if (
          !["http:", "https:"].includes(u.protocol) &&
          action.url !== "about:blank"
        )
          fail(
            "invalid_url",
            "Only HTTP(S) and about:blank navigation is supported",
          );
      }
      if (
        action.type === "wait" &&
        !["attached", "visible", "hidden", "detached", "enabled"].includes(
          action.state || "visible",
        )
      )
        fail("invalid_action", "Invalid wait state");
      if (action.type === "check" && typeof action.checked !== "boolean")
        fail("invalid_action", "checked must be boolean");
      if (
        action.type === "select" &&
        typeof action.value !== "string" &&
        !(
          Array.isArray(action.value) &&
          action.value.every((v) => typeof v === "string")
        )
      )
        fail("invalid_action", "value must be a string or string array");
      if (action.button && !["left", "middle", "right"].includes(action.button))
        fail("invalid_action", "Invalid mouse button");
      if (
        action.type === "drag" &&
        !(
          action.to ||
          (Array.isArray(action.path) &&
            action.path.length &&
            action.path.length <= 100)
        )
      )
        fail("invalid_action", "drag requires to or a bounded path");
      for (const k of ["deltaX", "deltaY"])
        if (
          action[k] !== undefined &&
          (!Number.isFinite(action[k]) || Math.abs(action[k]) > 10000)
        )
          fail("invalid_action", "Scroll delta must be within ±10000");
    }
  }
  async function request(method, path, body = {}, transport = "local") {
    const startJob = (tabId, run, ...args) => {
      const job = queue.start(tabId, async (task, signal) => {
        const finish = onActivity(tabId);
        const abort = () => finish(true);
        signal.addEventListener('abort', abort, { once: true });
        try { return await run(task, signal); }
        finally {
          signal.removeEventListener('abort', abort);
          finish(signal.aborted);
        }
      }, ...args);
      jobOrigins.set(job.id, transport);
      job.done.finally(() => jobOrigins.delete(job.id));
      return job;
    };
    const u = new URL(path, "http://relay.local"),
      p = u.pathname,
      options = method === "GET" ? Object.fromEntries(u.searchParams) : body;
    const sessionId = options.sessionId;
    if (sessionId) {
      if (typeof sessionId !== "string" || !/^[\w.-]{1,128}$/.test(sessionId))
        fail("invalid_session", "Invalid session id");
      if (!sessionOrigins.has(sessionId) && sessionOrigins.size >= 500)
        sessionOrigins.delete(sessionOrigins.keys().next().value);
      sessionOrigins.set(sessionId, transport);
    }
    const publicClaim = (c) => c && { ...c, tabId: publicTabId(c.tabId) };
    const own = (tabId) => {
      sessions.check(tabId, sessionId);
      if (sessionId) sessions.claim(tabId, sessionId);
    };
    if (method === "GET" && p === "/api/capabilities")
      return {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        features: FEATURES,
        maxActions: 100,
        ...runtimeInfo(),
      };
    if (p === "/api/sessions") {
      if (method === "GET")
        return { ok: true, claims: sessions.list().map(publicClaim) };
      if (body.action === "heartbeat")
        return { ok: true, ...sessions.touch(sessionId) };
      if (body.action === "stop") {
        sessionOrigins.delete(sessionId);
        return {
          ok: true,
          released: sessions.stop(sessionId).map(publicClaim),
        };
      }
      fail("invalid_request", "Session action must be heartbeat or stop");
    }
    if (p === "/api/session/check") {
      sessions.check(await resolveTab(options.tabId), sessionId);
      return { ok: true };
    }
    if (
      ["/api/tabs/claim", "/api/tabs/release", "/api/tabs/handoff"].includes(
        p,
      ) &&
      method === "POST"
    ) {
      const tabId = await resolveTab(body.tabId);
      const claim = p.endsWith("/claim")
        ? sessions.claim(tabId, sessionId, { label: body.label })
        : p.endsWith("/release")
          ? sessions.release(tabId, sessionId)
          : sessions.handoff(tabId, sessionId, body.toSessionId);
      return { ok: true, claim: publicClaim(claim) };
    }
    const taskMatch = p.match(/^\/api\/tasks\/([^/]+)(\/cancel)?$/);
    if (taskMatch) {
      let task;
      try {
        task = queue.get(taskMatch[1]);
      } catch (error) {
        if (
          error.code === "task_not_found" &&
          method === "POST" &&
          taskMatch[2]
        )
          return {
            ok: true,
            task: queue.cancel(taskMatch[1], "task_cancelled", sessionId),
          };
        throw error;
      }
      if (task.sessionId && task.sessionId !== sessionId)
        fail("task_owned", "Task belongs to another session", 409);
      return {
        ok: true,
        task:
          method === "POST" && taskMatch[2] ? queue.cancel(taskMatch[1]) : task,
      };
    }
    if (p === "/api/tabs/create" && method === "POST") {
      if (sessionId) sessions.touch(sessionId);
      const created = await createTab(body.url || "about:blank");
      if (sessionId)
        sessions.claim(await resolveTab(created.tabId), sessionId, {
          created: true,
        });
      return { ok: true, ...created };
    }
    if (p === "/api/tabs/focus" && method === "POST")
      return request("POST", "/api/actions", {
        ...body,
        actions: [{ type: "focus" }],
      }, transport);
    if (p === "/api/evaluate" && method === "POST") {
      if (typeof body.expression !== "string")
        fail("invalid_request", "expression is required");
      const tabId = await resolveTab(body.tabId);
      own(tabId);
      const job = startJob(
        tabId,
        async (_, signal) => {
          signals.set(tabId, signal);
          try {
            return { ok: true, value: await evaluate(tabId, body.expression) };
          } finally {
            signals.delete(tabId);
          }
        },
        20000,
        body.taskId,
        sessionId,
      );
      const result = await job.done;
      if (result.error)
        throw new TaskError(
          result.error.code,
          result.error.message,
          result.error.status,
        );
      return result.observation;
    }
    if (p === "/api/tabs/close" && method === "POST") {
      const tabId = await resolveTab(body.tabId);
      own(tabId);
      if (queue.active().some((job) => job.tabId === tabId))
        fail("tab_busy", "Cancel and await tasks before closing the tab", 409);
      invalidate(tabId);
      await closeTab(tabId);
      sessions.forget(tabId);
      return { ok: true };
    }
    if (p === "/api/observe" || p === "/api/read") {
      const tabId = await resolveTab(options.tabId);
      own(tabId);
      const job = startJob(
        tabId,
        async (_, signal) => {
          signals.set(tabId, signal);
          try {
            return await observe(tabId, {
              ...options,
              mode: p === "/api/read" ? "read" : options.mode,
              diff: options.diff === true || options.diff === "true",
              includeNodes:
                options.includeNodes === true ||
                options.includeNodes === "true",
              maxLength:
                options.maxLength === undefined
                  ? undefined
                  : Number(options.maxLength),
            });
          } finally {
            signals.delete(tabId);
          }
        },
        20000,
        options.taskId,
        sessionId,
      );
      const result = await job.done;
      if (result.error)
        throw new TaskError(
          result.error.code,
          result.error.message,
          result.error.status,
        );
      return result.observation;
    }
    if (p === "/api/actions" && method === "POST") {
      validate(body.actions);
      if (
        !["none", "snapshot", "read", "screenshot", "both"].includes(
          body.observe || "snapshot",
        )
      )
        fail(
          "invalid_request",
          "observe must be none, snapshot, read, screenshot, or both",
        );
      if (!body.tabId)
        fail("invalid_request", "Explicit tabId is required for actions");
      const tabId = await resolveTab(body.tabId),
        timeoutMs = integer(body.timeoutMs, 20000, 1, 120000);
      own(tabId);
      if (timeoutMs > 20000 && body.async !== true)
        fail(
          "async_required",
          "Tasks longer than 20 seconds must use async:true",
        );
      const { id, done } = startJob(
        tabId,
        async (job, signal) => {
          sessions.check(tabId, sessionId);
          signals.set(tabId, signal);
          try {
            for (const [index, action] of body.actions.entries()) {
              checkCancelled(signal);
              job.currentAction = { index, type: action.type };
              const start = Date.now(),
                result = await perform(tabId, action, signal);
              job.results.push({
                type: action.type,
                elapsedMs: Date.now() - start,
                ...result,
              });
              job.currentAction = undefined;
            }
            checkCancelled(signal);
            return body.observe === "none"
              ? undefined
              : await observe(tabId, {
                  mode: body.observe,
                  sessionId: body.sessionId,
                  diff: body.diff !== false,
                  maxLength: body.maxLength,
                });
          } finally {
            await releaseInputs(tabId);
            signals.delete(tabId);
          }
        },
        timeoutMs,
        body.taskId,
        sessionId,
      );
      if (body.async === true) return { ok: true, task: queue.get(id) };
      const task = await done;
      return {
        ok: task.status === "completed",
        task,
        ...(task.error
          ? {
              code: task.error.code,
              message: task.error.message,
              error: task.error.message,
              status: task.error.status,
            }
          : {}),
      };
    }
    fail(
      "endpoint_not_found",
      `Unknown automation endpoint: ${method} ${p}`,
      404,
    );
  }
  return {
    request,
    observe,
    screenshot,
    invalidate,
    activeTasks: queue.active,
    sessions,
    disconnect: (transport = "local") => {
      for (const job of queue.active())
        if (jobOrigins.get(job.id) === transport)
          queue.cancel(job.id, "extension_disconnected");
      for (const [id, origin] of sessionOrigins)
        if (origin === transport) {
          sessions.stop(id, "extension_disconnected");
          sessionOrigins.delete(id);
        }
    },
    cancelAll: queue.cancelAll,
    attachChild: (tabId, entry) => {
      if (!children.has(tabId)) children.set(tabId, new Map());
      children.get(tabId).set(entry.targetInfo.targetId, entry);
    },
    detachChild: (tabId, sessionId) => {
      for (const [id, c] of children.get(tabId) || [])
        if (c.sessionId === sessionId) children.get(tabId).delete(id);
    },
    close: (tabId) => {
      invalidate(tabId);
      sessions.forget(tabId);
      children.delete(tabId);
      queue.cancelTab(tabId);
    },
  };
}
