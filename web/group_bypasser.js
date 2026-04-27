import { app } from "../../scripts/app.js";

const NODE_NAME = "ComfyUI-Group-Bypasser";
const MODE_ACTIVE = LiteGraph.ALWAYS;
const MODE_BYPASS = 4;
const STATE_KEY = "group_bypasser_states";
const REFRESH_MS = 400;

function isTargetNodeDef(nodeData) {
  return String(nodeData?.name || "") === NODE_NAME;
}

function isTargetNodeInstance(node) {
  const candidates = [node?.type, node?.comfyClass, node?.constructor?.type, node?.constructor?.title]
    .map((value) => String(value || ""));
  return candidates.includes(NODE_NAME);
}

function normalizeTitle(title) {
  return String(title || "").trim();
}

function keyForTitle(title) {
  return normalizeTitle(title).toLowerCase();
}

function getCurrentGraph(node) {
  return node?.graph || app?.canvas?.getCurrentGraph?.() || app?.graph;
}

function getGroupBounds(group) {
  const bounds = group?._bounding || group?.bounding;
  if (!Array.isArray(bounds) || bounds.length < 4) {
    return null;
  }
  return bounds;
}

function getGroupNodes(group, graph) {
  if (!group || !graph) {
    return [];
  }

  try {
    if (typeof group.recomputeInsideNodes === "function") {
      group.recomputeInsideNodes();
    }
  } catch (error) {
    // Fall through to stale-membership fallback.
  }

  const fromChildren = Array.from(group?._children || []).filter((node) => typeof node?.id === "number");
  if (fromChildren.length) {
    return fromChildren;
  }

  const bounds = getGroupBounds(group);
  if (!bounds) {
    return [];
  }

  const [gx, gy, gw, gh] = bounds;
  return (graph._nodes || []).filter((graphNode) => {
    if (typeof graphNode?.id !== "number") {
      return false;
    }
    const pos = graphNode.pos || [0, 0];
    const size = Array.isArray(graphNode.size) ? graphNode.size : [140, 80];
    const centerX = Number(pos[0] || 0) + Number(size[0] || 0) * 0.5;
    const centerY = Number(pos[1] || 0) + Number(size[1] || 0) * 0.5;
    return centerX >= gx && centerX < gx + gw && centerY >= gy && centerY < gy + gh;
  });
}

function collectGroupsByTitle(node) {
  const graph = getCurrentGraph(node);
  if (!graph) {
    return [];
  }

  const sourceGroups = Array.isArray(graph._groups)
    ? graph._groups
    : Array.isArray(graph.groups)
      ? graph.groups
      : [];

  const deduped = new Map();

  for (const group of sourceGroups) {
    const title = normalizeTitle(group?.title);
    if (!title) {
      continue;
    }
    const key = keyForTitle(title);
    if (!deduped.has(key)) {
      deduped.set(key, {
        key,
        title,
        groups: [],
      });
    }
    deduped.get(key).groups.push(group);
  }

  return Array.from(deduped.values()).sort((a, b) => a.title.localeCompare(b.title));
}

function ensureStateStore(node) {
  if (!node.properties || typeof node.properties !== "object") {
    node.properties = {};
  }
  if (!node.properties[STATE_KEY] || typeof node.properties[STATE_KEY] !== "object") {
    node.properties[STATE_KEY] = {};
  }
  return node.properties[STATE_KEY];
}

function findWidget(node, name) {
  return (node.widgets || []).find((widget) => widget.name === name);
}

function applyModeToGroupTitle(node, groupEntry, enabled) {
  const graph = getCurrentGraph(node);
  if (!graph) {
    return;
  }

  const seenNodeIds = new Set();
  const mode = enabled ? MODE_ACTIVE : MODE_BYPASS;

  for (const group of groupEntry.groups) {
    for (const targetNode of getGroupNodes(group, graph)) {
      if (!(targetNode && Number.isInteger(targetNode.id) && targetNode.id >= 0)) {
        continue;
      }
      if (seenNodeIds.has(targetNode.id)) {
        continue;
      }
      seenNodeIds.add(targetNode.id);
      targetNode.mode = mode;
    }
  }

  graph.setDirtyCanvas(true, true);
}

function resolveEnabledFromGroups(node, groupEntry) {
  const graph = getCurrentGraph(node);
  if (!graph) {
    return true;
  }

  const seenNodeIds = new Set();
  let allBypassed = true;
  let anyFound = false;

  for (const group of groupEntry.groups) {
    for (const targetNode of getGroupNodes(group, graph)) {
      if (!(targetNode && Number.isInteger(targetNode.id) && targetNode.id >= 0)) {
        continue;
      }
      if (seenNodeIds.has(targetNode.id)) {
        continue;
      }
      seenNodeIds.add(targetNode.id);
      anyFound = true;
      if (targetNode.mode !== MODE_BYPASS) {
        allBypassed = false;
      }
    }
  }

  if (!anyFound) {
    return true;
  }
  return !allBypassed;
}

function getEntryByKey(node, key) {
  return collectGroupsByTitle(node).find((entry) => entry.key === key) || null;
}

function computeSignature(groupsByTitle) {
  return groupsByTitle.map((entry) => entry.key).join("|");
}

function syncWidgets(node, groupsByTitle, stateStore) {
  for (const entry of groupsByTitle) {
    const widgetName = `Bypass ${entry.title}`;
    const widget = findWidget(node, widgetName);
    if (!widget || !widget.__groupBypasserDynamic) {
      continue;
    }
    const isEnabled = resolveEnabledFromGroups(node, entry);
    stateStore[entry.key] = isEnabled;
    widget.value = isEnabled;
  }
}

function removeDynamicWidgets(node) {
  let index = 0;
  while ((node.widgets || [])[index]) {
    if (node.widgets[index]?.__groupBypasserDynamic) {
      node.removeWidget(index);
      continue;
    }
    index += 1;
  }
}

function refreshNode(node) {
  if (!isTargetNodeInstance(node)) {
    return;
  }

  const groupsByTitle = collectGroupsByTitle(node);
  const stateStore = ensureStateStore(node);
  const signature = computeSignature(groupsByTitle);

  // Drop stale state keys.
  const activeKeys = new Set(groupsByTitle.map((entry) => entry.key));
  for (const key of Object.keys(stateStore)) {
    if (!activeKeys.has(key)) {
      delete stateStore[key];
    }
  }

  if (node.__groupBypasserSignature === signature) {
    syncWidgets(node, groupsByTitle, stateStore);
    app.graph?.setDirtyCanvas?.(true, true);
    return;
  }

  node.__groupBypasserSignature = signature;
  removeDynamicWidgets(node);

  for (const entry of groupsByTitle) {
    const widgetName = `Bypass ${entry.title}`;
    const isEnabled = resolveEnabledFromGroups(node, entry);
    stateStore[entry.key] = isEnabled;

    const widget = node.addWidget(
      "toggle",
      widgetName,
      isEnabled,
      (value) => {
        const enabled = Boolean(value);
        const latestEntry = getEntryByKey(node, entry.key);
        if (!latestEntry) {
          return;
        }
        stateStore[entry.key] = enabled;
        applyModeToGroupTitle(node, latestEntry, enabled);
      },
      {
        on: "enabled",
        off: "disabled",
      },
    );

    widget.__groupBypasserDynamic = true;
    widget.__groupBypasserKey = entry.key;
    widget.value = isEnabled;
  }

  node.setSize([node.size[0], node.computeSize()[1]]);
  app.graph?.setDirtyCanvas?.(true, true);
}

function bindNode(node) {
  if (node.__groupBypasserBound) {
    return;
  }
  node.__groupBypasserBound = true;

  const originalOnRemoved = node.onRemoved;
  node.onRemoved = function () {
    if (this.__groupBypasserRefreshTimer) {
      clearInterval(this.__groupBypasserRefreshTimer);
      this.__groupBypasserRefreshTimer = null;
    }
    return originalOnRemoved?.apply(this, arguments);
  };

  // Keep frame list up-to-date while preserving saved states by title key.
  node.__groupBypasserRefreshTimer = setInterval(() => {
    if (!node.graph) {
      return;
    }
    refreshNode(node);
  }, REFRESH_MS);
}

app.registerExtension({
  name: "comfy.group.bypasser",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!isTargetNodeDef(nodeData)) {
      return;
    }

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    const originalOnConfigure = nodeType.prototype.onConfigure;

    nodeType.prototype.onNodeCreated = function () {
      const result = originalOnNodeCreated?.apply(this, arguments);
      bindNode(this);
      setTimeout(() => refreshNode(this), 0);
      setTimeout(() => refreshNode(this), 80);
      setTimeout(() => refreshNode(this), 250);
      return result;
    };

    nodeType.prototype.onConfigure = function () {
      const result = originalOnConfigure?.apply(this, arguments);
      bindNode(this);
      setTimeout(() => refreshNode(this), 0);
      setTimeout(() => refreshNode(this), 80);
      return result;
    };
  },

  loadedGraphNode(node) {
    if (!isTargetNodeInstance(node)) {
      return;
    }
    bindNode(node);
    setTimeout(() => refreshNode(node), 0);
    setTimeout(() => refreshNode(node), 80);
  },
});
