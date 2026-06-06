const express = require('express');
const http = require('http');
const cors = require('cors');
const { ComputeGraph } = require('./compute-graph');
const { StructuredError } = require('./expression-parser');
const { WebSocketManager } = require('./websocket-server');
const { SnapshotManager } = require('./snapshot-manager');
const { AuditEngine } = require('./audit-engine');
const { NamespaceManager } = require('./namespace-manager');
const { TemplateManager } = require('./template-manager');
const { BaselineEngine } = require('./baseline-engine');
const { demoCells, demoNamespaces, demoSandboxScript } = require('./demo-data');
const { runSandbox, getAvailableSlots, MAX_CONCURRENT_SANDBOXES } = require('./sandbox-engine');
const { RuleEngine } = require('./rule-engine');
const { globalPerfTracker } = require('./perf-tracker');
const { ScheduleEngine, MAX_SCHEDULES } = require('./schedule-engine');
const { LockManager } = require('./lock-manager');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-key';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const computeGraph = new ComputeGraph();
const wsManager = new WebSocketManager(computeGraph);
const snapshotManager = new SnapshotManager();
const auditEngine = new AuditEngine();
const nsManager = new NamespaceManager(ADMIN_KEY);
const templateManager = new TemplateManager(ADMIN_KEY);
const ruleEngine = new RuleEngine();
const baselineEngine = new BaselineEngine();
const scheduleEngine = new ScheduleEngine();
const globalLockManager = new LockManager();
ruleEngine.setWebSocketManager(wsManager);
wsManager.setNamespaceManager(nsManager);
nsManager.setWebSocketManager(wsManager);
wsManager.setGlobalLockManager(globalLockManager);
wsManager.attach(server);
scheduleEngine.setWebSocketManager(wsManager);
scheduleEngine.setContextProvider(null, () => ({
  computeGraph,
  snapshotManager,
  baselineEngine,
  wsManager,
  namespace: null
}));

computeGraph.getPerfTracker().setOnAlertCallback((alert) => {
  wsManager.broadcastPerfAlert(alert, null);
});

nsManager.setPerfAlertCallback((alert, namespace) => {
  wsManager.broadcastPerfAlert(alert, namespace);
});

function getOperator(req) {
  return req.headers['x-operator-id'] || 'anonymous';
}

function captureCellDefs() {
  const defs = {};
  for (const [name, cell] of computeGraph.cells.entries()) {
    defs[name] = { type: cell.type, rawValue: cell.rawValue };
  }
  return defs;
}

function loadDemoData() {
  console.log('正在导入演示数据...');
  try {
    const beforeDefs = captureCellDefs();
    const { changes } = computeGraph.importGraph({ cells: demoCells });
    const afterDefs = captureCellDefs();
    const allNames = new Set([...Object.keys(beforeDefs), ...Object.keys(afterDefs)]);
    for (const name of allNames) {
      const oldDef = beforeDefs[name] || null;
      const newDef = afterDefs[name] || null;
      const changed = !oldDef || !newDef ||
        oldDef.type !== newDef.type || oldDef.rawValue !== newDef.rawValue;
      if (changed) {
        auditEngine.append('import', 'system', name, oldDef, newDef);
      }
    }
    console.log(`演示数据导入成功，${changes.length} 个单元格值已计算`);
  } catch (e) {
    console.error('演示数据导入失败:', e.message);
  }
}

function loadDemoNamespaces() {
  console.log('正在导入演示命名空间...');
  const sortedNamespaces = [...demoNamespaces].sort((a, b) => {
    const aHasCrossRefs = a.cells.some(c => c.type === 'formula' && c.value.includes('::'));
    const bHasCrossRefs = b.cells.some(c => c.type === 'formula' && c.value.includes('::'));
    if (aHasCrossRefs && !bHasCrossRefs) return 1;
    if (!aHasCrossRefs && bHasCrossRefs) return -1;
    return 0;
  });

  for (const nsDef of sortedNamespaces) {
    try {
      const ns = nsManager.createNamespace(nsDef.name);
      console.log(`命名空间 '${nsDef.name}' 已创建，管理密钥: ${ns.key}`);

      const nsObj = nsManager.getNamespace(nsDef.name);
      if (nsObj && nsObj.lockManager) {
        setupLockManagerCallbacks(nsObj.lockManager, nsDef.name);
      }

      for (const cellName of nsDef.publishedCells) {
        const cell = nsDef.cells.find(c => c.name === cellName);
        if (cell) {
          try {
            nsObj.computeGraph.createCell(cell.name, cell.type, cell.value);
            console.log(`  单元格 '${cell.name}' 已创建 (待发布)`);
          } catch (e) {
            console.error(`  单元格 '${cellName}' 创建失败:`, e.message);
          }
        }
      }

      for (const cellName of nsDef.publishedCells) {
        nsManager.publishCell(nsDef.name, cellName);
        console.log(`  单元格 '${cellName}' 已发布`);
      }

      for (const cell of nsDef.cells) {
        if (nsDef.publishedCells.includes(cell.name)) continue;
        try {
          nsObj.computeGraph.createCell(cell.name, cell.type, cell.value);
          console.log(`  单元格 '${cell.name}' 已创建`);
        } catch (e) {
          console.error(`  单元格 '${cell.name}' 创建失败:`, e.message);
        }
      }
    } catch (e) {
      console.error(`命名空间 '${nsDef.name}' 创建失败:`, e.message);
    }
  }
}

function requireNamespace(req, res, next) {
  const namespace = req.headers['x-namespace'];
  const authKey = req.headers['x-auth-key'];

  if (!namespace) {
    return next();
  }

  if (!authKey) {
    return res.status(401).json({ error: '缺少 X-Auth-Key 头' });
  }

  const result = nsManager.authenticate(namespace, authKey);
  if (!result.valid) {
    return res.status(401).json({ error: result.error });
  }

  req.namespace = namespace;
  req.nsInfo = result.namespace;
  req.isNamespaceAdmin = result.isAdmin;
  next();
}

function requireNamespaceStrict(req, res, next) {
  const namespace = req.headers['x-namespace'];
  const authKey = req.headers['x-auth-key'];

  if (!namespace) {
    return res.status(400).json({ error: '缺少 X-Namespace 头，此操作必须指定命名空间' });
  }

  if (!authKey) {
    return res.status(401).json({ error: '缺少 X-Auth-Key 头' });
  }

  const result = nsManager.authenticate(namespace, authKey);
  if (!result.valid) {
    return res.status(401).json({ error: result.error });
  }

  req.namespace = namespace;
  req.nsInfo = result.namespace;
  req.isNamespaceAdmin = result.isAdmin;
  next();
}

function requireAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_KEY) {
    return res.status(401).json({ error: '管理员密钥无效' });
  }
  req.isAdmin = true;
  next();
}

function getComputeGraph(req) {
  if (req.namespace && req.nsInfo) {
    return req.nsInfo.computeGraph;
  }
  return computeGraph;
}

function getSnapshotManager(req) {
  if (req.namespace && req.nsInfo) {
    return req.nsInfo.snapshotManager;
  }
  return snapshotManager;
}

function getAuditEngine(req) {
  if (req.namespace && req.nsInfo) {
    return req.nsInfo.auditEngine;
  }
  return auditEngine;
}

function getPerfTracker(req) {
  if (req.namespace && req.nsInfo) {
    return req.nsInfo.computeGraph.getPerfTracker();
  }
  return computeGraph.getPerfTracker();
}

function getRuleEngine(req) {
  if (req.namespace && req.nsInfo) {
    return req.nsInfo.ruleEngine;
  }
  return ruleEngine;
}

function getBaselineEngine(req) {
  if (req.namespace && req.nsInfo) {
    return req.nsInfo.baselineEngine;
  }
  return baselineEngine;
}

function getScheduleEngine(req) {
  return scheduleEngine;
}

function getLockManager(req) {
  if (req.namespace && req.nsInfo) {
    return req.nsInfo.lockManager;
  }
  return globalLockManager;
}

function isAdmin(req) {
  const adminKey = req.headers['x-admin-key'];
  return !!(adminKey && adminKey === ADMIN_KEY);
}

function getLockToken(req) {
  return req.headers['x-lock-token'] || null;
}

function augmentCellWithLockInfo(cell, lockManager) {
  if (!cell) return cell;
  if (!lockManager) return { ...cell, locked: false, lockedBy: null };
  const lockInfo = lockManager.getLockInfo(cell.name);
  if (lockInfo) {
    return { ...cell, locked: true, lockedBy: lockInfo.lockedBy };
  }
  return { ...cell, locked: false, lockedBy: null };
}

function augmentCellsWithLockInfo(cells, lockManager) {
  if (!lockManager) return cells.map(c => ({ ...c, locked: false, lockedBy: null }));
  return cells.map(cell => augmentCellWithLockInfo(cell, lockManager));
}

function setupLockManagerCallbacks(lockManager, namespace) {
  lockManager.setCallbacks(
    (name, lockedBy, expiresAt) => {
      wsManager.broadcastCellLocked(name, lockedBy, expiresAt, namespace);
    },
    (name) => {
      wsManager.broadcastCellUnlocked(name, namespace);
    },
    (name) => {
      wsManager.broadcastCellUnlocked(name, namespace);
    }
  );
}

setupLockManagerCallbacks(globalLockManager, null);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', onlineCount: wsManager.getOnlineCount() });
});

app.get('/api/perf/recent', requireNamespace, (req, res) => {
  const perfTracker = getPerfTracker(req);
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 50) : 50;
  res.json({ records: perfTracker.getRecentRecords(limit) });
});

app.get('/api/perf/cells', requireNamespace, (req, res) => {
  const perfTracker = getPerfTracker(req);
  res.json({ cells: perfTracker.getCellStats() });
});

app.get('/api/perf/heatmap', requireNamespace, (req, res) => {
  const perfTracker = getPerfTracker(req);
  res.json(perfTracker.getHeatmapData());
});

app.post('/api/perf/threshold', requireNamespace, (req, res) => {
  const { thresholdMs } = req.body;
  if (thresholdMs === undefined || thresholdMs === null || isNaN(Number(thresholdMs))) {
    return res.status(400).json({ error: '必须提供有效的 thresholdMs 参数' });
  }
  const perfTracker = getPerfTracker(req);
  perfTracker.setThreshold(Number(thresholdMs));
  res.json({ success: true, thresholdMs: perfTracker.getThreshold() });
});

app.get('/api/perf/threshold', requireNamespace, (req, res) => {
  const perfTracker = getPerfTracker(req);
  res.json({ thresholdMs: perfTracker.getThreshold() });
});

app.get('/api/cells', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  const lockManager = getLockManager(req);
  const cells = augmentCellsWithLockInfo(graph.getAllCells(), lockManager);
  res.json({ cells });
});

app.get('/api/cells/export', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  const data = graph.exportGraph();
  res.setHeader('Content-Disposition', 'attachment; filename=graph-export.json');
  res.json(data);
});

app.post('/api/cells/import', requireNamespace, (req, res) => {
  const data = req.body;
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);
  const lockManager = getLockManager(req);
  const token = getLockToken(req);
  const admin = isAdmin(req);
  const beforeDefs = {};

  for (const [name, cell] of graph.cells.entries()) {
    beforeDefs[name] = { type: cell.type, rawValue: cell.rawValue };
  }

  if (!admin && data && Array.isArray(data.cells)) {
    const importNames = data.cells.map(c => c.name);
    const currentNames = Array.from(graph.cells.keys());
    const allAffectedNames = Array.from(new Set([...importNames, ...currentNames]));
    const lockedCells = lockManager.getLockedNames(allAffectedNames, token, false);
    if (lockedCells.length > 0) {
      return res.status(423).json({
        error: '导入被拒绝，部分单元格已被锁定。使用 X-Admin-Key 可强制跳过锁检查。',
        lockedCells: lockedCells.map(lc => ({
          name: lc.name,
          lockedBy: lc.lockedBy
        }))
      });
    }
  }

  try {
    const { changes, errors } = graph.importGraph(data);

    if (req.namespace) {
      wsManager.broadcastChangesToNamespace(req.namespace, changes);
    } else {
      wsManager.broadcastChanges(changes);
    }

    const afterDefs = {};
    for (const [name, cell] of graph.cells.entries()) {
      afterDefs[name] = { type: cell.type, rawValue: cell.rawValue };
    }
    const allNames = new Set([...Object.keys(beforeDefs), ...Object.keys(afterDefs)]);
    for (const name of allNames) {
      const oldDef = beforeDefs[name] || null;
      const newDef = afterDefs[name] || null;
      const changed = !oldDef || !newDef ||
        oldDef.type !== newDef.type || oldDef.rawValue !== newDef.rawValue;
      if (changed) {
        audit.append('import', operator, name, oldDef, newDef);
      }
    }

    res.json({ success: true, changes, errors });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/cells/:name', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  const lockManager = getLockManager(req);
  const cell = graph.getCell(req.params.name);
  if (!cell) {
    return res.status(404).json({ error: `单元格 '${req.params.name}' 不存在` });
  }
  res.json({ cell: augmentCellWithLockInfo(cell, lockManager) });
});

app.get('/api/cells/:name/compiled', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  const status = graph.getCompiledStatus(req.params.name);
  if (!status) {
    return res.status(404).json({ error: `单元格 '${req.params.name}' 不存在` });
  }
  res.json(status);
});

app.get('/api/cells/:name/trace', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  try {
    const trace = graph.traceCell(req.params.name);
    res.json(trace);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.post('/api/cells', requireNamespace, (req, res) => {
  const { name, type, value, lazy } = req.body;
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);

  if (!name || !type || value === undefined) {
    return res.status(400).json({ error: '缺少必要参数: name, type, value' });
  }

  try {
    const { cell, changes } = graph.createCell(name, type, value, { lazy: !!lazy });

    if (req.namespace) {
      wsManager.broadcastChangesToNamespace(req.namespace, changes);
      nsManager.propagateCrossNamespaceChange(req.namespace, [name], wsManager);
    } else {
      wsManager.broadcastChanges(changes);
    }

    const rules = getRuleEngine(req);
    if (changes.length > 0) {
      rules.checkRules(graph, req.namespace);
    }

    audit.append('create', operator, name, null, { type, rawValue: value, lazy: !!lazy });
    res.json({ cell, changes });
  } catch (e) {
    const errorResp = { error: e.message };
    if (e instanceof StructuredError) {
      errorResp.structuredError = e.toJSON();
    }
    res.status(400).json(errorResp);
  }
});

app.put('/api/cells/:name', requireNamespace, (req, res) => {
  const { name } = req.params;
  const { type, value, renameTo, lazy } = req.body;
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);
  const lockManager = getLockManager(req);
  const token = getLockToken(req);
  const admin = isAdmin(req);

  if (!lockManager.checkAccess(name, token, admin)) {
    return res.status(423).json({
      error: `单元格 '${name}' 已被锁定，需要有效的 X-Lock-Token`,
      locked: true
    });
  }

  if (renameTo) {
    try {
      if (!lockManager.checkAccess(renameTo, token, admin)) {
        return res.status(423).json({
          error: `目标单元格 '${renameTo}' 已被锁定，需要有效的 X-Lock-Token`,
          locked: true
        });
      }

      const existingCell = graph.getCell(name);
      const oldDef = existingCell ? { type: existingCell.type, rawValue: existingCell.rawValue } : null;

      const { cell, changes } = graph.renameCell(name, renameTo);

      try {
        lockManager.renameLock(name, renameTo, token, admin);
      } catch (lockErr) {
        graph.renameCell(renameTo, name);
        const statusCode = lockErr.statusCode || 400;
        return res.status(statusCode).json({ error: lockErr.message });
      }

      if (req.namespace) {
        wsManager.broadcastChangesToNamespace(req.namespace, changes);
        wsManager.broadcastCellDeletedInNamespace(req.namespace, name);
      } else {
        wsManager.broadcastChanges(changes);
        wsManager.broadcastCellDeleted(name);
      }

      const rules = getRuleEngine(req);
      rules.onCellRenamed(name, renameTo);

      audit.append('delete', operator, name, oldDef, null);
      audit.append('create', operator, renameTo, null, { type: cell.type, rawValue: cell.rawValue });

      return res.json({ cell, changes, renamed: true, oldName: name, newName: renameTo });
    } catch (e) {
      const errorResp = { error: e.message };
      if (e instanceof StructuredError) {
        errorResp.structuredError = e.toJSON();
      }
      return res.status(400).json(errorResp);
    }
  }

  if (!type || value === undefined) {
    return res.status(400).json({ error: '缺少必要参数: type, value' });
  }

  try {
    const existingCell = graph.getCell(name);
    const oldDef = existingCell ? { type: existingCell.type, rawValue: existingCell.rawValue, lazy: existingCell.lazy } : null;

    const { cell, changes } = graph.updateCell(name, type, value, { lazy });

    if (req.namespace) {
      wsManager.broadcastChangesToNamespace(req.namespace, changes);
      nsManager.propagateCrossNamespaceChange(req.namespace, [name], wsManager);
    } else {
      wsManager.broadcastChanges(changes);
    }

    const rules = getRuleEngine(req);
    if (changes.length > 0) {
      rules.checkRules(graph, req.namespace);
    }

    audit.append('update', operator, name, oldDef, { type, rawValue: value, lazy: lazy !== undefined ? !!lazy : (existingCell ? existingCell.lazy : false) });
    res.json({ cell, changes });
  } catch (e) {
    const errorResp = { error: e.message };
    if (e instanceof StructuredError) {
      errorResp.structuredError = e.toJSON();
    }
    res.status(400).json(errorResp);
  }
});

app.delete('/api/cells/:name', requireNamespace, (req, res) => {
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);
  const lockManager = getLockManager(req);
  const token = getLockToken(req);
  const admin = isAdmin(req);
  const existingCell = graph.getCell(req.params.name);
  const oldDef = existingCell ? { type: existingCell.type, rawValue: existingCell.rawValue } : null;

  if (!lockManager.checkAccess(req.params.name, token, admin)) {
    return res.status(423).json({
      error: `单元格 '${req.params.name}' 已被锁定，需要有效的 X-Lock-Token`,
      locked: true
    });
  }

  try {
    graph.deleteCell(req.params.name);

    if (req.namespace) {
      wsManager.broadcastCellDeletedInNamespace(req.namespace, req.params.name);
      nsManager.propagateCrossNamespaceChange(req.namespace, [req.params.name], wsManager);
    } else {
      wsManager.broadcastCellDeleted(req.params.name);
    }

    const rules = getRuleEngine(req);
    rules.onCellDeleted(req.params.name);

    audit.append('delete', operator, req.params.name, oldDef, null);
    res.json({ success: true, deleted: req.params.name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/cells/batch', requireNamespace, (req, res) => {
  const { cells } = req.body;
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);
  const lockManager = getLockManager(req);
  const token = getLockToken(req);
  const admin = isAdmin(req);

  if (!Array.isArray(cells)) {
    return res.status(400).json({ error: 'cells 必须是数组' });
  }

  const allAffectedNames = new Set();
  for (const c of cells) {
    allAffectedNames.add(c.name);
    if (c.renameTo) {
      allAffectedNames.add(c.renameTo);
    }
  }
  const lockedCells = lockManager.getLockedNames(Array.from(allAffectedNames), token, admin);
  if (lockedCells.length > 0) {
    return res.status(423).json({
      error: '批量操作被拒绝，部分单元格已被锁定',
      lockedCells: lockedCells.map(lc => ({
        name: lc.name,
        lockedBy: lc.lockedBy
      }))
    });
  }

  const beforeDefs = {};
  for (const [name, cell] of graph.cells.entries()) {
    beforeDefs[name] = { type: cell.type, rawValue: cell.rawValue };
  }

  const graphSnapshot = graph.snapshot();

  try {
    const { changes, errors } = graph.batchCreateOrUpdate(cells);

    const renamedPairs = cells.filter(c => c.renameTo);
    const lockRollbacks = [];
    let lockFailed = false;
    let lockError = null;
    let lockStatusCode = 400;

    for (const rc of renamedPairs) {
      try {
        const result = lockManager.renameLock(rc.name, rc.renameTo, token, admin);
        if (result.renamed) {
          lockRollbacks.push({ from: rc.renameTo, to: rc.name });
        }
      } catch (lockErr) {
        lockFailed = true;
        lockError = lockErr.message;
        lockStatusCode = lockErr.statusCode || 400;
        for (let i = lockRollbacks.length - 1; i >= 0; i--) {
          const rb = lockRollbacks[i];
          try {
            lockManager.renameLock(rb.from, rb.to, token, admin);
          } catch (_) {}
        }
        break;
      }
    }

    if (lockFailed) {
      try {
        graph.restore(graphSnapshot);
      } catch (_) {}
      return res.status(lockStatusCode).json({ error: lockError });
    }

    if (req.namespace) {
      wsManager.broadcastChangesToNamespace(req.namespace, changes);
      const renamedCells = cells.filter(c => c.renameTo);
      for (const rc of renamedCells) {
        wsManager.broadcastCellDeletedInNamespace(req.namespace, rc.name);
      }
      const changedNames = cells.map(c => c.renameTo || c.name);
      nsManager.propagateCrossNamespaceChange(req.namespace, changedNames, wsManager);
    } else {
      wsManager.broadcastChanges(changes);
      const renamedCells = cells.filter(c => c.renameTo);
      for (const rc of renamedCells) {
        wsManager.broadcastCellDeleted(rc.name);
      }
    }

    const afterDefs = {};
    for (const [name, cell] of graph.cells.entries()) {
      afterDefs[name] = { type: cell.type, rawValue: cell.rawValue };
    }
    const allNames = new Set([...Object.keys(beforeDefs), ...Object.keys(afterDefs)]);
    for (const name of allNames) {
      const oldDef = beforeDefs[name] || null;
      const newDef = afterDefs[name] || null;
      const changed = !oldDef || !newDef ||
        oldDef.type !== newDef.type || oldDef.rawValue !== newDef.rawValue;
      if (changed) {
        const opType = !oldDef ? 'create' : !newDef ? 'delete' : 'update';
        audit.append(opType, operator, name, oldDef, newDef);
      }
    }

    const rules = getRuleEngine(req);
    if (changes.length > 0) {
      rules.checkRules(graph, req.namespace);
    }

    res.json({ success: true, changes, errors });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/cells/:name/lock', requireNamespace, (req, res) => {
  const { name } = req.params;
  const graph = getComputeGraph(req);
  const lockManager = getLockManager(req);
  const operator = getOperator(req);

  if (!graph.cells.has(name)) {
    return res.status(404).json({ error: `单元格 '${name}' 不存在` });
  }

  try {
    const result = lockManager.lock(name, operator);
    res.json({
      success: true,
      name,
      lockToken: result.lockToken,
      expiresAt: result.expiresAt
    });
  } catch (e) {
    const statusCode = e.statusCode || 400;
    res.status(statusCode).json({ error: e.message });
  }
});

app.delete('/api/cells/:name/lock', requireNamespace, (req, res) => {
  const { name } = req.params;
  const lockManager = getLockManager(req);
  const token = getLockToken(req);
  const admin = isAdmin(req);

  try {
    const result = lockManager.unlock(name, token, admin);
    res.json(result);
  } catch (e) {
    const statusCode = e.statusCode || 400;
    res.status(statusCode).json({ error: e.message });
  }
});

app.put('/api/cells/:name/lock/renew', requireNamespace, (req, res) => {
  const { name } = req.params;
  const lockManager = getLockManager(req);
  const token = getLockToken(req);
  const admin = isAdmin(req);

  try {
    const result = lockManager.renew(name, token, admin);
    res.json({
      success: true,
      name,
      expiresAt: result.expiresAt
    });
  } catch (e) {
    const statusCode = e.statusCode || 400;
    res.status(statusCode).json({ error: e.message });
  }
});

app.get('/api/locks', requireNamespace, (req, res) => {
  const lockManager = getLockManager(req);
  res.json({ locks: lockManager.getAllLocks() });
});

app.get('/api/cache/stats', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  res.json(graph.getCacheStats());
});

app.post('/api/cache/invalidate', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  const result = graph.invalidateAllCaches();
  res.json(result);
});

app.get('/api/cache/cells', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  res.json({ cells: graph.getAllCacheDetails() });
});

app.get('/api/cache/benchmark', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  const result = graph.runBenchmark();
  if (result.error) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post('/api/snapshots', requireNamespace, (req, res) => {
  const { label } = req.body;
  const graph = getComputeGraph(req);
  const snapMgr = getSnapshotManager(req);
  const snapshotInfo = snapMgr.createSnapshot(graph, label);
  res.json(snapshotInfo);
});

app.get('/api/snapshots', requireNamespace, (req, res) => {
  const snapMgr = getSnapshotManager(req);
  res.json({ snapshots: snapMgr.getSnapshots() });
});

app.get('/api/snapshots/diff', requireNamespace, (req, res) => {
  const { a, b } = req.query;
  const graph = getComputeGraph(req);
  const snapMgr = getSnapshotManager(req);

  if (!a || !b) {
    return res.status(400).json({ error: '需要提供两个快照ID: a 和 b' });
  }

  let snapshotA;
  let snapshotB;

  if (a === 'current') {
    const currentCells = {};
    for (const [name, cell] of graph.cells.entries()) {
      currentCells[name] = {
        type: cell.type,
        rawValue: cell.rawValue,
        value: cell.value ? { ...cell.value } : null,
        error: cell.error
      };
    }
    snapshotA = { cells: currentCells };
  } else {
    snapshotA = snapMgr.getSnapshot(a);
    if (!snapshotA) {
      return res.status(404).json({ error: `快照 ${a} 不存在` });
    }
  }

  if (b === 'current') {
    const currentCells = {};
    for (const [name, cell] of graph.cells.entries()) {
      currentCells[name] = {
        type: cell.type,
        rawValue: cell.rawValue,
        value: cell.value ? { ...cell.value } : null,
        error: cell.error
      };
    }
    snapshotB = { cells: currentCells };
  } else {
    snapshotB = snapMgr.getSnapshot(b);
    if (!snapshotB) {
      return res.status(404).json({ error: `快照 ${b} 不存在` });
    }
  }

  const diff = snapMgr.compareSnapshots(snapshotA, snapshotB);
  res.json(diff);
});

app.get('/api/snapshots/:id', requireNamespace, (req, res) => {
  const snapMgr = getSnapshotManager(req);
  const snapshot = snapMgr.getSnapshot(req.params.id);
  if (!snapshot) {
    return res.status(404).json({ error: '快照不存在' });
  }
  res.json(snapshot);
});

app.delete('/api/snapshots/:id', requireNamespace, (req, res) => {
  const snapMgr = getSnapshotManager(req);
  const deleted = snapMgr.deleteSnapshot(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: '快照不存在' });
  }
  res.json({ success: true });
});

app.post('/api/snapshots/:id/restore', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  const snapMgr = getSnapshotManager(req);
  const audit = getAuditEngine(req);
  const operator = getOperator(req);
  const lockManager = getLockManager(req);
  const token = getLockToken(req);
  const admin = isAdmin(req);

  const targetSnapshot = snapMgr.getSnapshot(req.params.id);
  if (!targetSnapshot) {
    return res.status(404).json({ error: '快照不存在' });
  }

  if (!admin) {
    const snapshotCellNames = Object.keys(targetSnapshot.cells);
    const currentCellNames = Array.from(graph.cells.keys());
    const allAffectedNames = Array.from(new Set([...snapshotCellNames, ...currentCellNames]));
    const lockedCells = lockManager.getLockedNames(allAffectedNames, token, false);
    if (lockedCells.length > 0) {
      return res.status(423).json({
        error: '快照恢复被拒绝，部分单元格已被锁定。使用 X-Admin-Key 可强制跳过锁检查。',
        lockedCells: lockedCells.map(lc => ({
          name: lc.name,
          lockedBy: lc.lockedBy
        }))
      });
    }
  }

  const beforeDefs = {};
  for (const [name, cell] of graph.cells.entries()) {
    beforeDefs[name] = { type: cell.type, rawValue: cell.rawValue };
  }

  const beforeRestoreSnapshot = snapMgr.createSnapshot(
    graph,
    `auto: before restore to #${targetSnapshot.id}`
  );

  const originalSnapshot = graph.snapshot();

  try {
    graph.restore(targetSnapshot.cells);

    if (req.namespace) {
      wsManager.broadcastRestoreToNamespace(req.namespace);
    } else {
      wsManager.broadcastRestore();
    }

    const afterDefs = {};
    for (const [name, cell] of graph.cells.entries()) {
      afterDefs[name] = { type: cell.type, rawValue: cell.rawValue };
    }
    const allNames = new Set([...Object.keys(beforeDefs), ...Object.keys(afterDefs)]);
    for (const name of allNames) {
      const oldDef = beforeDefs[name] || null;
      const newDef = afterDefs[name] || null;
      const changed = !oldDef || !newDef ||
        oldDef.type !== newDef.type || oldDef.rawValue !== newDef.rawValue;
      if (changed) {
        audit.append('restore', operator, name, oldDef, newDef);
      }
    }

    const rules = getRuleEngine(req);
    rules.checkRules(graph, req.namespace);

    res.json({
      success: true,
      beforeRestoreSnapshot,
      restoredSnapshotId: targetSnapshot.id
    });
  } catch (e) {
    graph.restore(originalSnapshot);
    res.status(500).json({ error: '恢复快照失败: ' + e.message });
  }
});

app.get('/api/audit/logs', requireNamespace, (req, res) => {
  const audit = getAuditEngine(req);
  const { from, to, cell, operator, limit, offset } = req.query;
  const result = audit.query({
    from: from ? Number(from) : undefined,
    to: to ? Number(to) : undefined,
    cell: cell || undefined,
    operator: operator || undefined,
    limit: limit ? Number(limit) : 50,
    offset: offset ? Number(offset) : 0,
  });
  res.json(result);
});

app.get('/api/audit/logs/:seq', requireNamespace, (req, res) => {
  const audit = getAuditEngine(req);
  const entry = audit.getBySeq(req.params.seq);
  if (!entry) {
    return res.status(404).json({ error: `日志 seq=${req.params.seq} 不存在` });
  }
  res.json(entry);
});

app.get('/api/audit/stats', requireNamespace, (req, res) => {
  const audit = getAuditEngine(req);
  res.json(audit.getStats());
});

app.post('/api/audit/replay', requireNamespace, (req, res) => {
  const audit = getAuditEngine(req);
  const { timestamp, seq } = req.body;

  if (timestamp === undefined && seq === undefined) {
    return res.status(400).json({ error: '必须提供 timestamp 或 seq 参数' });
  }

  try {
    const result = audit.replay({ timestamp, seq });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function performUndo(seq, graph, audit, wsManager, namespace, nsMgr, rules, operator, force = true, options = {}) {
  const { emitEvents = true, runRules = true } = options;
  const log = audit.getBySeq(seq);
  if (!log) {
    return { success: false, seq, error: `日志 seq=${seq} 不存在` };
  }

  if (log.type === 'undo') {
    return { success: false, seq, error: '不能撤销一条撤销操作' };
  }

  const laterChanges = audit.getLaterChanges(log.cellName, log.seq);
  const hasConflict = laterChanges.length > 0;

  if (hasConflict && !force) {
    return {
      success: false,
      seq,
      conflict: true,
      laterChanges: laterChanges.map(l => ({
        seq: l.seq,
        type: l.type,
        operator: l.operator,
        timestamp: l.timestamp
      })),
      error: '存在后续修改，撤销被拒绝（设置 force:true 可强制执行）'
    };
  }

  const cellName = log.cellName;
  const existingCell = graph.getCell(cellName);
  const oldDef = log.oldDef;
  const newDef = log.newDef;

  const isCreateOp = oldDef === null;

  if (isCreateOp) {
    if (existingCell) {
      const downstream = graph.getDownstream(cellName);
      if (downstream.length > 0) {
        return {
          success: false,
          seq,
          error: `无法删除，以下单元格仍在引用它: ${downstream.join(', ')}`,
          referencedBy: downstream
        };
      }
      try {
        graph.deleteCell(cellName);
      } catch (e) {
        return { success: false, seq, error: e.message };
      }

      if (emitEvents) {
        if (namespace) {
          wsManager.broadcastCellDeletedInNamespace(namespace, cellName);
          nsMgr.propagateCrossNamespaceChange(namespace, [cellName], wsManager);
        } else {
          wsManager.broadcastCellDeleted(cellName);
        }
      }

      const afterDef = null;
      const beforeDefForLog = newDef ? { type: newDef.type, rawValue: newDef.rawValue } : null;
      audit.append('undo', operator, cellName, beforeDefForLog, afterDef, { undoTarget: log.seq });

      if (rules && runRules) {
        rules.onCellDeleted(cellName);
      }

      return {
        success: true,
        seq,
        action: 'delete',
        cell: cellName,
        changed: true,
        conflict: hasConflict,
        laterChanges: hasConflict ? laterChanges.map(l => ({
          seq: l.seq, type: l.type, operator: l.operator, timestamp: l.timestamp
        })) : undefined
      };
    } else {
      const beforeDefForLog = null;
      audit.append('undo', operator, cellName, beforeDefForLog, null, { undoTarget: log.seq });
      return {
        success: true,
        seq,
        action: 'noop',
        cell: cellName,
        changed: false,
        note: '单元格原本就不存在',
        conflict: hasConflict,
        laterChanges: hasConflict ? laterChanges.map(l => ({
          seq: l.seq, type: l.type, operator: l.operator, timestamp: l.timestamp
        })) : undefined
      };
    }
  }

  const targetType = oldDef.type;
  const targetValue = oldDef.rawValue;

  if (!existingCell) {
    try {
      const { cell, changes } = graph.createCell(cellName, targetType, targetValue);

      if (emitEvents) {
        if (namespace) {
          wsManager.broadcastChangesToNamespace(namespace, changes);
          nsMgr.propagateCrossNamespaceChange(namespace, [cellName], wsManager);
        } else {
          wsManager.broadcastChanges(changes);
        }
      }

      const beforeDefForLog = null;
      audit.append('undo', operator, cellName, beforeDefForLog, { type: targetType, rawValue: targetValue }, { undoTarget: log.seq });

      if (rules && runRules) {
        rules.checkRules(graph, namespace);
      }

      return {
        success: true,
        seq,
        action: 'recreate',
        cell: cellName,
        changed: true,
        conflict: hasConflict,
        laterChanges: hasConflict ? laterChanges.map(l => ({
          seq: l.seq, type: l.type, operator: l.operator, timestamp: l.timestamp
        })) : undefined
      };
    } catch (e) {
      return { success: false, seq, error: e.message };
    }
  }

  try {
    const beforeDefForLog = { type: existingCell.type, rawValue: existingCell.rawValue };
    const { cell, changes } = graph.updateCell(cellName, targetType, targetValue);

    if (emitEvents) {
      if (namespace) {
        wsManager.broadcastChangesToNamespace(namespace, changes);
        nsMgr.propagateCrossNamespaceChange(namespace, [cellName], wsManager);
      } else {
        wsManager.broadcastChanges(changes);
      }
    }

    audit.append('undo', operator, cellName, beforeDefForLog, { type: targetType, rawValue: targetValue }, { undoTarget: log.seq });

    if (rules && runRules) {
      rules.checkRules(graph, namespace);
    }

    return {
      success: true,
      seq,
      action: 'restore',
      cell: cellName,
      changed: true,
      conflict: hasConflict,
      laterChanges: hasConflict ? laterChanges.map(l => ({
        seq: l.seq, type: l.type, operator: l.operator, timestamp: l.timestamp
      })) : undefined
    };
  } catch (e) {
    return { success: false, seq, error: e.message };
  }
}

app.post('/api/audit/undo/:seq', requireNamespace, (req, res) => {
  const seq = Number(req.params.seq);
  const { force = true } = req.body || {};
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);
  const namespace = req.namespace || null;
  const rules = getRuleEngine(req);

  if (isNaN(seq)) {
    return res.status(400).json({ error: '无效的 seq 参数' });
  }

  scheduleEngine.stop();
  try {
    const result = performUndo(seq, graph, audit, wsManager, namespace, nsManager, rules, operator, force);

    if (!result.success) {
      if (result.conflict) {
        return res.status(409).json(result);
      }
      return res.status(400).json(result);
    }

    res.json(result);
  } finally {
    scheduleEngine.start();
  }
});

app.post('/api/audit/undo-range', requireNamespace, (req, res) => {
  const { fromSeq, toSeq, force = true } = req.body || {};
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);
  const namespace = req.namespace || null;
  const rules = getRuleEngine(req);

  const from = Number(fromSeq);
  const to = Number(toSeq);

  if (isNaN(from) || isNaN(to)) {
    return res.status(400).json({ error: 'fromSeq 和 toSeq 必须是有效数字' });
  }

  if (from > to) {
    return res.status(400).json({ error: 'fromSeq 不能大于 toSeq' });
  }

  const seqs = [];
  for (let s = to; s >= from; s--) {
    seqs.push(s);
  }

  scheduleEngine.stop();

  const originalSnapshot = graph.snapshot();
  const originalLogsLength = audit.logs.length;
  const originalNextSeq = audit.nextSeq;

  const results = [];
  const changedCells = new Set();
  let failed = false;
  let failureError = null;

  try {
    for (const seq of seqs) {
      const result = performUndo(
        seq, graph, audit, wsManager, namespace, nsManager, rules, operator, force,
        { emitEvents: false, runRules: false }
      );
      results.push(result);
      if (!result.success) {
        failed = true;
        failureError = result.error || `撤销 seq=${seq} 失败`;
        break;
      }
      if (result.changed) {
        changedCells.add(result.cell);
      }
    }

    if (failed) {
      try {
        graph.restore(originalSnapshot);
      } catch (restoreErr) {
        console.error('批量撤销回滚 graph 失败:', restoreErr.message);
      }
      audit.logs.length = originalLogsLength;
      audit.nextSeq = originalNextSeq;

      if (namespace) {
        wsManager.broadcastRestoreToNamespace(namespace);
      } else {
        wsManager.broadcastRestore();
      }

      return res.status(400).json({
        success: false,
        error: failureError,
        rolledBack: true,
        partialResults: results
      });
    }

    if (namespace) {
      wsManager.broadcastRestoreToNamespace(namespace);
    } else {
      wsManager.broadcastRestore();
    }

    if (changedCells.size > 0) {
      nsManager.propagateCrossNamespaceChange(namespace, Array.from(changedCells), wsManager);
    }

    if (rules) {
      rules.checkRules(graph, namespace);
    }

    res.json({
      success: true,
      total: seqs.length,
      results
    });
  } finally {
    scheduleEngine.start();
  }
});

app.post('/api/namespaces', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: '缺少必要参数: name' });
  }
  try {
    const ns = nsManager.createNamespace(name);
    const nsObj = nsManager.getNamespace(name);
    if (nsObj && nsObj.lockManager) {
      setupLockManagerCallbacks(nsObj.lockManager, name);
    }
    res.json(ns);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/namespaces', requireAdmin, (req, res) => {
  res.json({ namespaces: nsManager.listNamespaces() });
});

app.get('/api/namespaces/:name', requireAdmin, (req, res) => {
  const ns = nsManager.getNamespace(req.params.name);
  if (!ns) {
    return res.status(404).json({ error: `命名空间 '${req.params.name}' 不存在` });
  }
  res.json({
    name: ns.name,
    cellCount: ns.computeGraph.cells.size,
    publishedCells: nsManager.getPublishedCells(req.params.name),
    createdAt: ns.createdAt
  });
});

app.delete('/api/namespaces/:name', requireAdmin, (req, res) => {
  try {
    const result = nsManager.forceDeleteNamespace(req.params.name, wsManager);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/namespaces/:name/cells', requireAdmin, (req, res) => {
  const ns = nsManager.getNamespace(req.params.name);
  if (!ns) {
    return res.status(404).json({ error: `命名空间 '${req.params.name}' 不存在` });
  }
  const cells = augmentCellsWithLockInfo(ns.computeGraph.getAllCells(), ns.lockManager);
  res.json({ cells });
});

app.post('/api/namespaces/:name/publish', requireNamespaceStrict, (req, res) => {
  if (req.namespace !== req.params.name && !req.isNamespaceAdmin) {
    return res.status(403).json({ error: '只能在自己的命名空间中发布单元格' });
  }
  const { cell } = req.body;
  if (!cell) {
    return res.status(400).json({ error: '缺少必要参数: cell' });
  }
  try {
    const result = nsManager.publishCell(req.params.name, cell);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/namespaces/:name/unpublish', requireNamespaceStrict, (req, res) => {
  if (req.namespace !== req.params.name && !req.isNamespaceAdmin) {
    return res.status(403).json({ error: '只能在自己的命名空间中撤销发布' });
  }
  const { cell } = req.body;
  if (!cell) {
    return res.status(400).json({ error: '缺少必要参数: cell' });
  }
  try {
    const result = nsManager.unpublishCell(req.params.name, cell);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/namespaces/:name/published', (req, res) => {
  const ns = nsManager.getNamespace(req.params.name);
  if (!ns) {
    return res.status(404).json({ error: `命名空间 '${req.params.name}' 不存在` });
  }
  res.json({ published: nsManager.getPublishedCells(req.params.name) });
});

app.get('/api/admin/cross-refs', requireAdmin, (req, res) => {
  const edges = nsManager.getCrossNamespaceRefGraph();
  res.json({ edges });
});

app.post('/api/templates', requireNamespaceStrict, (req, res) => {
  const { name, description, cellNames } = req.body;
  const graph = getComputeGraph(req);

  if (!name) {
    return res.status(400).json({ error: '缺少必要参数: name' });
  }
  if (!Array.isArray(cellNames)) {
    return res.status(400).json({ error: 'cellNames 必须是数组' });
  }

  try {
    const template = templateManager.createTemplate({
      namespace: req.namespace,
      name,
      description,
      cellNames,
      computeGraph: graph
    });
    res.json(template);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/templates', (req, res) => {
  res.json({ templates: templateManager.listTemplates() });
});

app.get('/api/templates/:id', (req, res) => {
  const template = templateManager.getTemplate(Number(req.params.id));
  if (!template) {
    return res.status(404).json({ error: '模板不存在' });
  }
  res.json(template);
});

app.delete('/api/templates/:id', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  const isAdmin = adminKey && adminKey === ADMIN_KEY;
  const namespace = req.headers['x-namespace'];

  try {
    const result = templateManager.deleteTemplate(Number(req.params.id), namespace, isAdmin);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/templates/:id/install', requireNamespaceStrict, (req, res) => {
  const { parameterOverrides, prefix } = req.body;
  const graph = getComputeGraph(req);
  const templateId = Number(req.params.id);
  const operator = getOperator(req);
  const audit = getAuditEngine(req);

  try {
    const { cells: cellsToCreate } = templateManager.installTemplate(templateId, {
      targetNamespace: req.namespace,
      computeGraph: graph,
      parameterOverrides,
      prefix
    });

    const beforeDefs = {};
    for (const [name, cell] of graph.cells.entries()) {
      beforeDefs[name] = { type: cell.type, rawValue: cell.rawValue };
    }

    const { changes, errors } = graph.batchCreateOrUpdate(cellsToCreate);

    if (req.namespace) {
      wsManager.broadcastChangesToNamespace(req.namespace, changes);
      const changedNames = cellsToCreate.map(c => c.name);
      nsManager.propagateCrossNamespaceChange(req.namespace, changedNames, wsManager);
    } else {
      wsManager.broadcastChanges(changes);
    }

    const afterDefs = {};
    for (const [name, cell] of graph.cells.entries()) {
      afterDefs[name] = { type: cell.type, rawValue: cell.rawValue };
    }
    const allNames = new Set([...Object.keys(beforeDefs), ...Object.keys(afterDefs)]);
    for (const name of allNames) {
      const oldDef = beforeDefs[name] || null;
      const newDef = afterDefs[name] || null;
      const changed = !oldDef || !newDef ||
        oldDef.type !== newDef.type || oldDef.rawValue !== newDef.rawValue;
      if (changed) {
        audit.append('template_install', operator, name, oldDef, newDef);
      }
    }

    res.json({
      success: true,
      installed: cellsToCreate.map(c => c.name),
      changes,
      errors
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function loadDemoTemplate() {
  console.log('正在创建演示模板...');
  try {
    const demoNsName = 'demo-templates';
    let demoNs = nsManager.getNamespace(demoNsName);
    if (!demoNs) {
      demoNs = nsManager.createNamespace(demoNsName);
      console.log(`演示模板命名空间 '${demoNsName}' 已创建，管理密钥: ${demoNs.key}`);
    }

    const demoNsObj = nsManager.getNamespace(demoNsName);
    if (demoNsObj && demoNsObj.lockManager) {
      setupLockManagerCallbacks(demoNsObj.lockManager, demoNsName);
    }

    for (const cell of demoCells) {
      if (!demoNsObj.computeGraph.cells.has(cell.name)) {
        try {
          demoNsObj.computeGraph.createCell(cell.name, cell.type, cell.value);
        } catch (e) {
        }
      }
    }

    const demoTplDef = templateManager.getDemoTemplateDefinition();
    templateManager.createTemplate({
      namespace: demoNsName,
      name: demoTplDef.name,
      description: demoTplDef.description,
      cellNames: demoTplDef.cellNames,
      computeGraph: demoNsObj.computeGraph
    });

    console.log(`演示模板 '${demoTplDef.name}' 已创建`);
  } catch (e) {
    console.error('演示模板创建失败:', e.message);
  }
}

app.get('/api/sandbox/demo', (req, res) => {
  res.json(demoSandboxScript);
});

app.get('/api/sandbox/status', (req, res) => {
  res.json({
    availableSlots: getAvailableSlots(),
    maxConcurrent: MAX_CONCURRENT_SANDBOXES
  });
});

app.post('/api/sandbox/run', requireNamespace, async (req, res) => {
  const { instructions } = req.body;
  const graph = getComputeGraph(req);

  if (!Array.isArray(instructions)) {
    return res.status(400).json({ error: 'instructions 必须是数组' });
  }

  try {
    const result = await runSandbox(graph, instructions);
    res.json(result);
  } catch (e) {
    const statusCode = e.statusCode || 400;
    res.status(statusCode).json({ error: e.message });
  }
});

app.post('/api/rules', requireNamespace, (req, res) => {
  const { targetCell, condition, actionType, actionParams, cooldown } = req.body;
  const graph = getComputeGraph(req);
  const rules = getRuleEngine(req);

  try {
    const rule = rules.createRule(graph, {
      targetCell,
      condition,
      actionType,
      actionParams,
      cooldown
    });
    res.json(rule);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/rules', requireNamespace, (req, res) => {
  const rules = getRuleEngine(req);
  res.json({ rules: rules.listRules() });
});

app.get('/api/rules/:id', requireNamespace, (req, res) => {
  const rules = getRuleEngine(req);
  const rule = rules.getRule(req.params.id);
  if (!rule) {
    return res.status(404).json({ error: `规则 ${req.params.id} 不存在` });
  }
  res.json(rule);
});

app.delete('/api/rules/:id', requireNamespace, (req, res) => {
  const rules = getRuleEngine(req);
  try {
    const result = rules.deleteRule(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.put('/api/rules/:id/enable', requireNamespace, (req, res) => {
  const rules = getRuleEngine(req);
  try {
    const result = rules.enableRule(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.put('/api/rules/:id/disable', requireNamespace, (req, res) => {
  const rules = getRuleEngine(req);
  try {
    const result = rules.disableRule(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/rules/:id/history', requireNamespace, (req, res) => {
  const rules = getRuleEngine(req);
  const history = rules.getRuleHistory(req.params.id);
  if (!history) {
    return res.status(404).json({ error: `规则 ${req.params.id} 不存在` });
  }
  res.json({ history });
});

app.post('/api/baselines', requireNamespace, (req, res) => {
  const { name, description } = req.body;
  const graph = getComputeGraph(req);
  const baselineEngine = getBaselineEngine(req);

  if (!name) {
    return res.status(400).json({ error: '缺少必要参数: name' });
  }

  try {
    const baseline = baselineEngine.createBaseline(graph, name, description);
    res.json(baseline);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/baselines', requireNamespace, (req, res) => {
  const baselineEngine = getBaselineEngine(req);
  res.json({ baselines: baselineEngine.getBaselines() });
});

app.get('/api/baselines/:id', requireNamespace, (req, res) => {
  const baselineEngine = getBaselineEngine(req);
  const baseline = baselineEngine.getBaseline(req.params.id);
  if (!baseline) {
    return res.status(404).json({ error: '基线不存在' });
  }
  res.json(baseline);
});

app.delete('/api/baselines/:id', requireNamespace, (req, res) => {
  const baselineEngine = getBaselineEngine(req);
  const deleted = baselineEngine.deleteBaseline(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: '基线不存在' });
  }
  res.json({ success: true });
});

app.post('/api/baselines/:id/check', requireNamespace, (req, res) => {
  const { tolerance } = req.body;
  const graph = getComputeGraph(req);
  const baselineEngine = getBaselineEngine(req);

  try {
    const result = baselineEngine.checkBaseline(
      req.params.id,
      graph,
      tolerance !== undefined ? Number(tolerance) : undefined
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/baselines/check-all', requireNamespace, (req, res) => {
  const { tolerance } = req.body;
  const graph = getComputeGraph(req);
  const baselineEngine = getBaselineEngine(req);

  try {
    const results = baselineEngine.checkAllBaselines(
      graph,
      tolerance !== undefined ? Number(tolerance) : undefined
    );
    res.json({ results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/baselines/:id/blame', requireNamespace, (req, res) => {
  const { tolerance } = req.body;
  const graph = getComputeGraph(req);
  const baselineEngine = getBaselineEngine(req);

  try {
    const result = baselineEngine.blame(
      req.params.id,
      graph,
      tolerance !== undefined ? Number(tolerance) : undefined
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/schedules', requireNamespace, (req, res) => {
  const { name, cron, enabled, actions } = req.body;
  const scheduleEngine = getScheduleEngine(req);

  if (!name) {
    return res.status(400).json({ error: '缺少必要参数: name' });
  }
  if (!cron) {
    return res.status(400).json({ error: '缺少必要参数: cron' });
  }
  if (!Array.isArray(actions)) {
    return res.status(400).json({ error: 'actions 必须是数组' });
  }

  try {
    const schedule = scheduleEngine.createSchedule({
      name,
      cron,
      enabled: enabled !== undefined ? enabled : true,
      actions,
      namespace: req.namespace || null
    });
    res.json(schedule);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/schedules', requireNamespace, (req, res) => {
  const scheduleEngine = getScheduleEngine(req);
  const schedules = scheduleEngine.getSchedules(req.namespace || null);
  res.json({ schedules });
});

app.get('/api/schedules/:id', requireNamespace, (req, res) => {
  const scheduleEngine = getScheduleEngine(req);
  const schedule = scheduleEngine.getSchedule(req.params.id, req.namespace || null);
  if (!schedule) {
    return res.status(404).json({ error: '调度任务不存在' });
  }
  res.json(schedule);
});

app.get('/api/schedules/:id/history', requireNamespace, (req, res) => {
  const scheduleEngine = getScheduleEngine(req);
  const result = scheduleEngine.getHistory(req.params.id, req.namespace || null);
  if (!result) {
    return res.status(404).json({ error: '调度任务不存在' });
  }
  res.json(result);
});

app.delete('/api/schedules/:id', requireNamespace, (req, res) => {
  const scheduleEngine = getScheduleEngine(req);
  const deleted = scheduleEngine.deleteSchedule(req.params.id, req.namespace || null);
  if (!deleted) {
    return res.status(404).json({ error: '调度任务不存在' });
  }
  res.json({ success: true });
});

app.put('/api/schedules/:id/pause', requireNamespace, (req, res) => {
  const scheduleEngine = getScheduleEngine(req);
  const result = scheduleEngine.pauseSchedule(req.params.id, req.namespace || null);
  if (!result) {
    return res.status(404).json({ error: '调度任务不存在' });
  }
  res.json(result);
});

app.put('/api/schedules/:id/resume', requireNamespace, (req, res) => {
  const scheduleEngine = getScheduleEngine(req);
  const result = scheduleEngine.resumeSchedule(req.params.id, req.namespace || null);
  if (!result) {
    return res.status(404).json({ error: '调度任务不存在' });
  }
  res.json(result);
});

app.get('/api/schedules/cron/validate', (req, res) => {
  const { CronParser } = require('./cron-parser');
  const cronParser = new CronParser();
  const { expression } = req.query;
  if (!expression) {
    return res.status(400).json({ error: '缺少 expression 参数' });
  }
  const result = cronParser.validate(expression);
  res.json(result);
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

loadDemoData();
loadDemoNamespaces();
loadDemoTemplate();

function loadDemoBaseline() {
  console.log('正在创建演示基线...');
  try {
    baselineEngine.createBaseline(computeGraph, '初始演示数据', '系统启动时自动创建的基线');
    console.log('演示基线已创建');
  } catch (e) {
    console.error('演示基线创建失败:', e.message);
  }
}

loadDemoBaseline();

function loadDemoSchedule() {
  console.log('正在创建演示调度...');
  try {
    const demoSchedule = scheduleEngine.createSchedule({
      name: '演示: 定时更新单价并检测基线',
      cron: '*/15 * * * * *',
      enabled: true,
      actions: [
        {
          type: 'set_value',
          cell: 'unit_price',
          value: { random: true, min: 50, max: 200 }
        },
        {
          type: 'snapshot',
          label: 'auto-${timestamp}'
        },
        {
          type: 'check_baseline',
          baselineId: 1
        }
      ],
      namespace: null
    });
    console.log(`演示调度已创建，ID: ${demoSchedule.id}`);
    console.log(`  - Cron: ${demoSchedule.cron} (每15秒执行一次)`);
    console.log(`  - 操作: 随机修改unit_price -> 拍快照 -> 基线检测`);
  } catch (e) {
    console.error('演示调度创建失败:', e.message);
  }
}

loadDemoSchedule();
scheduleEngine.start();
console.log('调度引擎已启动');

server.listen(PORT, () => {
  console.log(`表达式求值沙盘后端已启动`);
  console.log(`HTTP 服务器: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`演示数据已加载: ${demoCells.length} 个单元格`);
  console.log(`演示命名空间已加载: ${demoNamespaces.length} 个`);
  console.log(`模板市场已启用 (最多 ${templateManager.constructor.MAX_TEMPLATES || 100} 个模板)`);
  console.log(`基线回归引擎已启用 (最多 ${baselineEngine.constructor.MAX_BASELINES || 30} 条基线)`);
  console.log(`定时调度引擎已启用 (最多 ${MAX_SCHEDULES} 个调度任务)`);
  console.log(`单元格访问控制已启用 (锁有效期5分钟，每10秒自动扫描过期)`);
  console.log(`管理员密钥已配置 (ADMIN_KEY 环境变量${ADMIN_KEY === 'admin-secret-key' ? '，使用默认值' : ''})`);
});
