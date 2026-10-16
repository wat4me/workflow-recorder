/**
 * Semantic element analyzer for Workflow Recorder
 * Captures rich, structured DOM context for AI-driven selector inference.
 * Focuses on stability signals, structural paths, and semantic anchors.
 */

(function () {
  if (window.SemanticElementAnalyzer) return;

  // Short-lived exact node references, isolated from page scripts. Never persisted.
  const axTargets = new Map();
  window.__workflowAXTargets = axTargets;
  let axCounter = 0;
  let axCleanup = null;
  function retainAXTarget(element) {
    if (!globalThis.chrome?.runtime?.id) return undefined;
    const token = `ax_${Date.now()}_${++axCounter}_${Math.random().toString(36).slice(2)}`;
    if (axTargets.size >= 64) axTargets.delete(axTargets.keys().next().value);
    axTargets.set(token, element);
    if (!axCleanup) axCleanup = setTimeout(() => { axTargets.clear(); axCleanup = null; }, 5000);
    return token;
  }

  const SemanticElementAnalyzer = {
    /**
     * Main function to capture comprehensive element context.
     * @param {HTMLElement} element
     * @returns {Object} Structured capture data for AI analysis
     */
    analyze(element) {
      if (!element) return null;

      return {
        _axRef: retainAXTarget(element),
        // Core identification
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        className: element.getAttribute("class") || null,
        name: element.getAttribute("name") || null,
        type: element.getAttribute("type") || null,
        role: this.computeRole(element),
        accessibleName: this.computeAccessibleName(element),

        // Stability signals
        dataAttributes: this.extractDataAttributes(element),
        ariaAttributes: this.extractAriaAttributes(element),

        // Content & semantics
        textContent: this.cleanText(this.getElementText(element)).substring(0, 300),
        placeholder: element.getAttribute("placeholder") || null,
        title: element.getAttribute("title") || null,
        value: this.getElementValue(element),

        // Structural context
        domPath: this.computeDomPath(element),
        siblingInfo: this.getSiblingInfo(element),
        parentChain: this.getParentChain(element, 5),

        // Positional context
        boundingBox: this.getBoundingBox(element),

        // Surrounding anchors
        nearbyLandmarks: this.findNearbyLandmarks(element),
        nearbyTexts: this.findNearbyTexts(element),

        // Frame context
        frameInfo: this.getFrameInfo(),

        // Raw snapshot (sanitized: SVG/style stripped so text survives the cap)
        openTag: this.renderOpenTag(element),
        outerHTML: this.sanitizeHTML(element.outerHTML, 800)
      };
    },

    /**
     * Computes semantic ARIA role.
     */
    computeRole(element) {
      const explicitRole = element.getAttribute("role");
      if (explicitRole) return explicitRole.trim().toLowerCase();

      const tag = element.tagName.toUpperCase();
      const roleMap = {
        A: element.hasAttribute("href") ? "link" : null,
        BUTTON: "button",
        INPUT: this.getInputRole(element),
        TEXTAREA: "textbox",
        SELECT: "combobox",
        OPTION: "option",
        IMG: "img",
        H1: "heading", H2: "heading", H3: "heading",
        H4: "heading", H5: "heading", H6: "heading",
        NAV: "navigation",
        HEADER: "banner",
        MAIN: "main",
        FOOTER: "contentinfo",
        ASIDE: "complementary",
        SECTION: "region",
        ARTICLE: "article",
        FORM: "form",
        TABLE: "table",
        TR: "row",
        TD: "cell", TH: "cell",
        UL: "list", OL: "list",
        LI: "listitem"
      };
      return roleMap[tag] || null;
    },

    getInputRole(el) {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const map = {
        button: "button", image: "button", reset: "button", submit: "button",
        checkbox: "checkbox", radio: "radio",
        number: "spinbutton", range: "slider",
        search: "searchbox",
        tel: "textbox", url: "textbox", email: "textbox", password: "textbox", text: "textbox"
      };
      return map[type] || "textbox";
    },

    /**
     * Computes an accessible-name hint from a conservative subset of the
     * AccName sources available through ordinary DOM APIs.
     */
    computeAccessibleName(el) {
      // aria-labelledby
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const parts = labelledby.split(/\s+/)
          .map(id => {
            const labelEl = document.getElementById(id);
            return labelEl ? this.getElementText(labelEl) : "";
          })
          .filter(Boolean);
        if (parts.length) return this.cleanText(parts.join(" "));
      }

      // aria-label
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return this.cleanText(ariaLabel);

      // Associated label
      const tag = el.tagName.toUpperCase();
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (label) return this.cleanText(this.getElementText(label));
        }
        const parentLabel = el.closest("label");
        if (parentLabel) {
          const clone = parentLabel.cloneNode(true);
          const nested = clone.querySelector("input, textarea, select");
          if (nested) nested.remove();
          return this.cleanText(this.getElementText(clone));
        }
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) return this.cleanText(placeholder);
      }

      // Image alt
      if (tag === "IMG") {
        const alt = el.getAttribute("alt");
        if (alt !== null) return this.cleanText(alt);
      }

      // Button/link/menu-item content
      const role = this.computeRole(el);
      if (["button", "link", "heading", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem"].includes(role) || tag === "OPTION") {
        const content = this.getElementText(el);
        if (content) return this.cleanText(content);
      }

      // Title attribute
      const title = el.getAttribute("title");
      if (title) return this.cleanText(title);

      // Input value for buttons
      if (tag === "INPUT") {
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (["submit", "button", "reset"].includes(type)) {
          const val = el.getAttribute("value");
          if (val) return this.cleanText(val);
        }
      }

      return null;
    },

    /**
     * Extracts data-* attributes (stable signals).
     */
    extractDataAttributes(el) {
      const attrs = {};
      for (const attr of el.attributes || []) {
        if (attr.name.startsWith("data-")) {
          attrs[attr.name] = attr.value.substring(0, 200);
        }
      }
      return Object.keys(attrs).length ? attrs : null;
    },

    /**
     * Extracts aria-* attributes.
     */
    extractAriaAttributes(el) {
      const attrs = {};
      for (const attr of el.attributes || []) {
        if (attr.name.startsWith("aria-")) {
          attrs[attr.name] = attr.value.substring(0, 200);
        }
      }
      return Object.keys(attrs).length ? attrs : null;
    },

    /**
     * Gets element value (for inputs, selects, textareas). Values are recorded
     * as they are, password fields included -- see the recording disclosure.
     */
    getElementValue(el) {
      const tag = el.tagName.toUpperCase();
      if (tag === "INPUT") {
        return el.value || null;
      }
      if (tag === "TEXTAREA") {
        return el.value || null;
      }
      if (tag === "SELECT") {
        const selected = el.options[el.selectedIndex];
        return selected ? { value: selected.value, text: selected.text } : null;
      }
      return null;
    },

    /**
     * Computes CSS-style DOM path for structural reference.
     */
    computeDomPath(el) {
      const parts = [];
      let current = el;
      let depth = 0;

      while (current && current.nodeType === Node.ELEMENT_NODE && depth < 6) {
        let part = current.tagName.toLowerCase();

        if (current.id) {
          part += `#${CSS.escape(current.id)}`;
          parts.unshift(part);
          break;
        }

        // Add positional info
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(c => c.tagName === current.tagName)
          : [];
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          part += `:nth-of-type(${index})`;
        }

        parts.unshift(part);
        current = current.parentElement;
        depth++;
      }

      return parts.join(" > ");
    },

    /**
     * Captures sibling structure for nth-child inference.
     */
    getSiblingInfo(el) {
      if (!el.parentElement) return null;

      const siblings = Array.from(el.parentElement.children);
      const sameTagSiblings = siblings.filter(s => s.tagName === el.tagName);

      return {
        totalSiblings: siblings.length,
        sameTagCount: sameTagSiblings.length,
        indexAmongSameTag: sameTagSiblings.indexOf(el) + 1,
        indexAmongAll: siblings.indexOf(el) + 1,
        previousSibling: this.summarizeElement(el.previousElementSibling),
        nextSibling: this.summarizeElement(el.nextElementSibling)
      };
    },

    summarizeElement(el) {
      if (!el) return null;
      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || null,
        className: (el.getAttribute("class") || "").substring(0, 100),
        textPreview: this.cleanText(this.getElementText(el)).substring(0, 100)
      };
    },

    /**
     * Walks up the ancestor chain as compact opening tags, innermost first.
     *
     * This deliberately carries only what the step document renders. Earlier
     * revisions also stored each ancestor's serialized outerHTML plus its id,
     * class, role and data/aria maps; measured on a table-heavy page that was
     * 48% of everything recorded and no consumer ever read it.
     * renderDomSkeleton() in ui/generator.js uses openTag, with tagName as its
     * only fallback.
     */
    getParentChain(el, maxDepth = 5) {
      const chain = [];
      let current = el.parentElement;
      let depth = 0;

      while (current && current !== document.body && depth < maxDepth) {
        chain.push({
          tagName: current.tagName.toLowerCase(),
          openTag: this.renderOpenTag(current)
        });
        current = current.parentElement;
        depth++;
      }

      return chain.length ? chain : null;
    },

    /**
     * Renders a concise opening tag (whitelisted stable attrs, capped)
     * used for the compact DOM skeleton in step documents.
     */
    renderOpenTag(el) {
      const tag = el.tagName.toLowerCase();
      const wanted = ["id", "class", "name", "type", "placeholder", "title", "href", "src", "role"];
      const priority = ["id", "data-testid", "data-test-id", "data-test", "data-qa", "data-cy",
        "name", "role", "aria-label", "aria-labelledby", "aria-controls", "type", "href", "class", "placeholder", "title", "src"];
      const rank = name => {
        const index = priority.indexOf(name.toLowerCase());
        return index < 0 ? priority.length : index;
      };
      const parts = [];

      // Attribute insertion order is presentation detail, not locator priority.
      const attributes = Array.from(el.attributes || []).sort((a, b) => rank(a.name) - rank(b.name));
      for (const attr of attributes) {
        const n = attr.name.toLowerCase();
        const keep = wanted.includes(n) || n.startsWith("data-") || n.startsWith("aria-");
        if (!keep || !attr.value.trim()) continue;

        let v = attr.value.trim();
        if (n === "class") {
          v = v.split(/\s+/).slice(0, 4).join(" ").substring(0, 120);
        } else {
          v = v.substring(0, 80);
        }
        parts.push(`${attr.name}="${this.escapeHtml(v)}"`);
        if (parts.length >= 6) break;
      }

      return parts.length ? `<${tag} ${parts.join(" ")}>` : `<${tag}>`;
    },

    escapeHtml(text) {
      if (!text) return "";
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },

    /**
     * Gets bounding box for spatial reference.
     */
    getBoundingBox(el) {
      const rect = el.getBoundingClientRect();
      let x = rect.x;
      let y = rect.y;
      let width = rect.width;
      let height = rect.height;
      let currentWindow = window;
      let coordinateSpace = "top-viewport";

      // Element rectangles inside an iframe are local to that frame, while the
      // screencast is an image of the top-level viewport. Walk through accessible
      // same-origin ancestors so the two use the same coordinate system. When a
      // cross-origin boundary prevents that conversion, mark the rectangle as
      // frame-local; the screenshot writer will keep the clean image rather than
      // draw a confidently wrong box.
      while (currentWindow !== currentWindow.top) {
        try {
          const frameElement = currentWindow.frameElement;
          if (!frameElement) {
            coordinateSpace = "frame-viewport";
            break;
          }

          const frameRect = frameElement.getBoundingClientRect();
          const renderedScaleX = frameElement.offsetWidth > 0
            ? frameRect.width / frameElement.offsetWidth
            : 1;
          const renderedScaleY = frameElement.offsetHeight > 0
            ? frameRect.height / frameElement.offsetHeight
            : 1;
          x = frameRect.x + (frameElement.clientLeft + x) * renderedScaleX;
          y = frameRect.y + (frameElement.clientTop + y) * renderedScaleY;
          width *= renderedScaleX;
          height *= renderedScaleY;
          currentWindow = currentWindow.parent;
        } catch (error) {
          coordinateSpace = "frame-viewport";
          break;
        }
      }

      const viewportWidth = Number(
        currentWindow.innerWidth || currentWindow.document?.documentElement?.clientWidth
      );
      const viewportHeight = Number(
        currentWindow.innerHeight || currentWindow.document?.documentElement?.clientHeight
      );
      return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
        viewportWidth: Number.isFinite(viewportWidth) ? Math.round(viewportWidth) : null,
        viewportHeight: Number.isFinite(viewportHeight) ? Math.round(viewportHeight) : null,
        coordinateSpace
      };
    },

    /**
     * Finds nearby landmark elements for anchoring.
     */
    findNearbyLandmarks(el) {
      const landmarks = [];
      const container = el.closest("form, section, article, main, [role='dialog'], [role='form']") || document.body;

      // Find headings, labels, buttons in the container
      const candidates = container.querySelectorAll(
        "h1, h2, h3, h4, h5, h6, label, button, [role='button'], legend, caption"
      );

      for (const candidate of candidates) {
        if (candidate === el) continue;
        const text = this.cleanText(this.getElementText(candidate)).substring(0, 100);
        if (text && text.length > 1) {
          landmarks.push({
            tagName: candidate.tagName.toLowerCase(),
            role: this.computeRole(candidate),
            text: text,
            id: candidate.id || null
          });
        }
        if (landmarks.length >= 5) break;
      }

      return landmarks.length ? landmarks : null;
    },

    /**
     * Finds nearby unique text nodes for getByText anchoring.
     */
    findNearbyTexts(el) {
      const texts = new Set();
      const container = el.parentElement || document.body;

      // Walk up to find a container with limited scope
      let scope = container;
      for (let i = 0; i < 3 && scope.parentElement; i++) {
        scope = scope.parentElement;
        if (scope.children.length > 20) break;
      }

      const walker = document.createTreeWalker(
        scope,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            const text = this.cleanText(node.textContent);
            if (text.length >= 2 && text.length <= 50) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_REJECT;
          }
        }
      );

      let node;
      while ((node = walker.nextNode()) && texts.size < 8) {
        const text = this.cleanText(node.textContent);
        // Skip if it's inside the target element
        if (!el.contains(node)) {
          texts.add(text);
        }
      }

      return texts.size ? Array.from(texts) : null;
    },

    /**
     * Captures frame hierarchy for iframe context.
     */
    getFrameInfo() {
      const isIframe = window.self !== window.top;
      if (!isIframe) return null;

      let frameElement = null;
      try {
        frameElement = window.frameElement;
      } catch (error) {
        // Cross-origin frames still expose their own URL/title below.
      }

      return {
        isIframe: true,
        frameUrl: window.location.href,
        frameName: window.name || frameElement?.getAttribute("name") || frameElement?.id || null,
        frameId: frameElement?.id || null,
        frameTitle: document.title || null
      };
    },

    /**
     * Helper to retrieve and normalize text content.
     */
    getElementText(el) {
      if (!el) return "";
      let text = "";
      if (el.childNodes.length === 0) {
        text = el.textContent || "";
      } else {
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const style = window.getComputedStyle(node);
            if (
              node.tagName !== "SCRIPT" &&
              node.tagName !== "STYLE" &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            ) {
              text += " " + this.getElementText(node);
            }
          }
        }
      }
      return text;
    },

    cleanText(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    },

    truncate(str, maxLen) {
      if (!str) return null;
      return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
    },

    /**
     * Sanitizes raw HTML for capture: collapses inline <svg> blocks to a
     * placeholder and strips style/on* attributes. Icon-libraries inject
     * huge inline SVGs whose path data would otherwise eat the whole
     * length budget and push the element's own text out of the snapshot.
     */
    sanitizeHTML(html, maxLen) {
      if (!html) return null;
      let out = String(html)
        .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, "<svg/>")
        .replace(/\sstyle\s*=\s*"[^"]*"/gi, "")
        .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
      return this.truncate(out, maxLen);
    }
  };

  window.SemanticElementAnalyzer = SemanticElementAnalyzer;
  // Compatibility alias for sessions injected by an older extension build.
  window.AOMAnalyzer = SemanticElementAnalyzer;
})();
