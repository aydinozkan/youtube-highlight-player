/**
 * A deliberately tiny fake DOM for testing heatmapStrategy's element-
 * walking logic without pulling in jsdom. Supports only what that module
 * actually calls: querySelector/querySelectorAll with simple "tag",
 * ".class", or "tag.class" selectors, getAttribute, and a `style` object
 * with a `width` string (matching how YouTube sets it inline).
 */
function matchesSimpleSelector(el, selector) {
  var tagMatch = selector.match(/^[a-zA-Z][\w-]*/);
  var classMatches = selector.match(/\.[\w-]+/g) || [];
  if (tagMatch && el.tag !== tagMatch[0]) return false;
  var classAttr = " " + (el.attrs.class || "") + " ";
  for (var i = 0; i < classMatches.length; i += 1) {
    if (classAttr.indexOf(" " + classMatches[i].slice(1) + " ") === -1) return false;
  }
  return true;
}

function walk(el, selector, out) {
  if (matchesSimpleSelector(el, selector)) out.push(el);
  (el.children || []).forEach(function (child) { walk(child, selector, out); });
  return out;
}

function el(tag, attrs, style, children) {
  var node = {
    tag: tag,
    attrs: attrs || {},
    style: style || {},
    children: children || [],
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    querySelector: function (selector) { return walk(this, selector, [])[0] || null; },
    querySelectorAll: function (selector) { return walk(this, selector, []); },
    getBoundingClientRect: function () { return { width: parseFloat(this.style.width) || 0 }; },
  };
  return node;
}

function makeDoc(root) {
  return {
    querySelector: function (selector) { return walk(root, selector, [])[0] || null; },
    querySelectorAll: function (selector) { return walk(root, selector, []); },
  };
}

module.exports = { el: el, makeDoc: makeDoc };
