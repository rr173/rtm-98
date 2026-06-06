const crypto = require('crypto');
const { ComputeGraph } = require('./compute-graph');
const { SnapshotManager } = require('./snapshot-manager');
const { AuditEngine } = require('./audit-engine');
const { RuleEngine } = require('./rule-engine');
const { BaselineEngine } = require('./baseline-engine');
const { LockManager } = require('./lock-manager');

const MAX_NAMESPACES = 50;
const MAX_CELLS_PER_NAMESPACE = 500;
const NAMESPACE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

class NamespaceManager {
  constructor(adminKey) {
    this.adminKey = adminKey || 'admin-secret-key';
    this.namespaces = new Map();
    this.perfAlertCallback = null;
    this.wsManager = null;
  }

  setPerfAlertCallback(callback) {
    this.perfAlertCallback = callback;
  }

  setWebSocketManager(wsManager) {
    this.wsManager = wsManager;
    for (const ns of this.namespaces.values()) {
      ns.ruleEngine.setWebSocketManager(wsManager);
    }
  }

  generateKey() {
    return crypto.randomBytes(16).toString('hex');
  }

  validateNamespaceName(name) {
    if (!NAMESPACE_NAME_PATTERN.test(name)) {
      throw new Error(`命名空间名称 '${name}' 无效，必须以小写字母开头，由小写字母、数字和连字符组成`);
    }
    if (name.length > 64) {
      throw new Error('命名空间名称最长64个字符');
    }
  }

  createNamespace(name) {
    this.validateNamespaceName(name);

    if (this.namespaces.size >= MAX_NAMESPACES) {
      throw new Error(`最多支持 ${MAX_NAMESPACES} 个命名空间`);
    }

    if (this.namespaces.has(name)) {
      throw new Error(`命名空间 '${name}' 已存在`);
    }

    const key = this.generateKey();
    const computeGraph = new ComputeGraph(MAX_CELLS_PER_NAMESPACE);
    const snapshotManager = new SnapshotManager();
    const auditEngine = new AuditEngine();
    const ruleEngine = new RuleEngine();
    const baselineEngine = new BaselineEngine();
    const lockManager = new LockManager();

    const crossNamespaceResolver = (ns, cellName) => {
      return this.resolveCrossNamespaceRef(name, ns, cellName);
    };

    const crossDepValidator = (dep) => {
      return this.validateCrossNamespaceDep(name, dep);
    };

    computeGraph.setCrossNamespaceResolver(crossNamespaceResolver);
    computeGraph.setCrossDepValidator(crossDepValidator);

    const ns = {
      name,
      key,
      computeGraph,
      snapshotManager,
      auditEngine,
      ruleEngine,
      baselineEngine,
      lockManager,
      publishedCells: new Set(),
      createdAt: Date.now()
    };

    this.namespaces.set(name, ns);

    if (this.perfAlertCallback) {
      computeGraph.getPerfTracker().setOnAlertCallback((alert) => {
        this.perfAlertCallback(alert, name);
      });
    }

    if (this.wsManager) {
      ns.ruleEngine.setWebSocketManager(this.wsManager);
    }

    return { name, key, createdAt: ns.createdAt };
  }

  deleteNamespace(name) {
    const ns = this.namespaces.get(name);
    if (!ns) {
      throw new Error(`命名空间 '${name}' 不存在`);
    }

    for (const [otherName, otherNs] of this.namespaces.entries()) {
      if (otherName === name) continue;
      for (const [cellName, cell] of otherNs.computeGraph.cells.entries()) {
        const crossDeps = otherNs.computeGraph.getCrossDependencies(cell.dependencies);
        for (const dep of crossDeps) {
          if (dep.startsWith(`${name}::`)) {
            throw new Error(`无法删除命名空间 '${name}'，命名空间 '${otherName}' 的单元格 '${cellName}' 仍在引用它`);
          }
        }
      }
    }

    if (ns.lockManager) {
      ns.lockManager.stop();
    }
    this.namespaces.delete(name);
    return { success: true, deleted: name };
  }

  forceDeleteNamespace(name, wsManager = null) {
    const ns = this.namespaces.get(name);
    if (!ns) {
      throw new Error(`命名空间 '${name}' 不存在`);
    }

    const affectedNamespaces = new Map();

    for (const [otherName, otherNs] of this.namespaces.entries()) {
      if (otherName === name) continue;
      const cellsToRecalc = [];
      for (const [cellName, cell] of otherNs.computeGraph.cells.entries()) {
        const crossDeps = otherNs.computeGraph.getCrossDependencies(cell.dependencies);
        let affected = false;
        for (const dep of crossDeps) {
          if (dep.startsWith(`${name}::`)) {
            affected = true;
          }
        }
        if (affected) {
          cellsToRecalc.push(cellName);
        }
      }
      if (cellsToRecalc.length > 0) {
        affectedNamespaces.set(otherName, cellsToRecalc);
      }
    }

    if (ns.lockManager) {
      ns.lockManager.stop();
    }
    this.namespaces.delete(name);

    for (const [nsName, cells] of affectedNamespaces.entries()) {
      const affectedNs = this.namespaces.get(nsName);
      if (!affectedNs) continue;
      const { changes } = affectedNs.computeGraph.recalculateWithCrossDeps(cells);
      if (wsManager && changes.length > 0) {
        wsManager.broadcastChangesToNamespace(nsName, changes);
      }
    }

    return { success: true, deleted: name };
  }

  getNamespace(name) {
    return this.namespaces.get(name) || null;
  }

  listNamespaces() {
    return Array.from(this.namespaces.values()).map(ns => ({
      name: ns.name,
      cellCount: ns.computeGraph.cells.size,
      publishedCount: ns.publishedCells.size,
      createdAt: ns.createdAt
    }));
  }

  authenticate(namespaceName, authKey) {
    const ns = this.namespaces.get(namespaceName);
    if (!ns) {
      return { valid: false, error: `命名空间 '${namespaceName}' 不存在` };
    }
    if (authKey === ns.key || authKey === this.adminKey) {
      return { valid: true, namespace: ns, isAdmin: authKey === this.adminKey };
    }
    return { valid: false, error: '认证密钥不匹配' };
  }

  authenticateAdmin(adminKey) {
    if (adminKey === this.adminKey) {
      return true;
    }
    return false;
  }

  publishCell(namespaceName, cellName) {
    const ns = this.namespaces.get(namespaceName);
    if (!ns) {
      throw new Error(`命名空间 '${namespaceName}' 不存在`);
    }
    const cell = ns.computeGraph.cells.get(cellName);
    if (!cell) {
      throw new Error(`单元格 '${cellName}' 不存在于命名空间 '${namespaceName}'`);
    }
    ns.publishedCells.add(cellName);
    return { namespace: namespaceName, cell: cellName, published: true };
  }

  unpublishCell(namespaceName, cellName) {
    const ns = this.namespaces.get(namespaceName);
    if (!ns) {
      throw new Error(`命名空间 '${namespaceName}' 不存在`);
    }
    if (!ns.publishedCells.has(cellName)) {
      throw new Error(`单元格 '${cellName}' 未被发布`);
    }
    ns.publishedCells.delete(cellName);

    for (const [otherName, otherNs] of this.namespaces.entries()) {
      if (otherName === namespaceName) continue;
      const cellsToRecalc = [];
      for (const [cName, c] of otherNs.computeGraph.cells.entries()) {
        const crossDeps = otherNs.computeGraph.getCrossDependencies(c.dependencies);
        if (crossDeps.includes(`${namespaceName}::${cellName}`)) {
          cellsToRecalc.push(cName);
        }
      }
      if (cellsToRecalc.length > 0) {
        otherNs.computeGraph.recalculateWithCrossDeps(cellsToRecalc);
      }
    }

    return { namespace: namespaceName, cell: cellName, published: false };
  }

  isCellPublished(namespaceName, cellName) {
    const ns = this.namespaces.get(namespaceName);
    if (!ns) return false;
    return ns.publishedCells.has(cellName);
  }

  getPublishedCells(namespaceName) {
    const ns = this.namespaces.get(namespaceName);
    if (!ns) return [];
    return Array.from(ns.publishedCells);
  }

  validateCrossNamespaceDep(fromNamespace, dep) {
    const parts = dep.split('::');
    if (parts.length !== 2) {
      return { valid: false, error: `跨命名空间引用 '${dep}' 格式无效，应为 'namespace::cellname'` };
    }
    const [targetNs, targetCell] = parts;
    const ns = this.namespaces.get(targetNs);
    if (!ns) {
      return { valid: false, error: `命名空间 '${targetNs}' 不存在` };
    }
    const cell = ns.computeGraph.cells.get(targetCell);
    if (!cell) {
      return { valid: false, error: `单元格 '${targetCell}' 不存在于命名空间 '${targetNs}'` };
    }
    if (!ns.publishedCells.has(targetCell)) {
      return { valid: false, error: `单元格 '${targetCell}' 未被命名空间 '${targetNs}' 发布，不可跨命名空间引用` };
    }
    return { valid: true };
  }

  resolveCrossNamespaceRef(fromNamespace, targetNamespace, targetCell) {
    const ns = this.namespaces.get(targetNamespace);
    if (!ns) {
      return { value: null, error: `命名空间 '${targetNamespace}' 不存在` };
    }
    const cell = ns.computeGraph.cells.get(targetCell);
    if (!cell) {
      return { value: null, error: `单元格 '${targetCell}' 不存在于命名空间 '${targetNamespace}'` };
    }
    if (!ns.publishedCells.has(targetCell)) {
      return { value: null, error: `单元格 '${targetCell}' 未被发布，跨命名空间引用已失效` };
    }
    if (cell.error) {
      return { value: null, error: cell.error };
    }
    return { value: cell.value, error: null };
  }

  getCrossNamespaceRefGraph() {
    const edges = [];
    for (const [nsName, ns] of this.namespaces.entries()) {
      for (const [cellName, cell] of ns.computeGraph.cells.entries()) {
        const crossDeps = ns.computeGraph.getCrossDependencies(cell.dependencies);
        for (const dep of crossDeps) {
          const parts = dep.split('::');
          if (parts.length === 2) {
            edges.push({
              from: { namespace: nsName, cell: cellName },
              to: { namespace: parts[0], cell: parts[1] },
              published: this.isCellPublished(parts[0], parts[1])
            });
          }
        }
      }
    }
    return edges;
  }

  propagateCrossNamespaceChange(sourceNamespace, changedCellNames, wsManager) {
    const affectedNamespaces = new Map();

    for (const cellName of changedCellNames) {
      for (const [otherName, otherNs] of this.namespaces.entries()) {
        if (otherName === sourceNamespace) continue;
        const downstream = otherNs.computeGraph.getCrossNamespaceDownstream(sourceNamespace, cellName);
        if (downstream.length > 0) {
          if (!affectedNamespaces.has(otherName)) {
            affectedNamespaces.set(otherName, new Set());
          }
          for (const d of downstream) {
            affectedNamespaces.get(otherName).add(d);
          }
        }
      }
    }

    for (const [nsName, cellNames] of affectedNamespaces.entries()) {
      const ns = this.namespaces.get(nsName);
      if (!ns) continue;
      const changedArray = Array.from(cellNames);
      const { changes, errors } = ns.computeGraph.recalculateWithCrossDeps(changedArray);
      if (wsManager && changes.length > 0) {
        wsManager.broadcastChangesToNamespace(nsName, changes);
      }
    }
  }
}

module.exports = { NamespaceManager };
