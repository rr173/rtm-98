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
const { demoCells, demoNamespaces, demoSandboxScript } = require('./demo-data');
const { runSandbox, getAvailableSlots, MAX_CONCURRENT_SANDBOXES } = require('./sandbox-engine');

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
wsManager.setNamespaceManager(nsManager);
wsManager.attach(server);

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', onlineCount: wsManager.getOnlineCount() });
});

app.get('/api/cells', requireNamespace, (req, res) => {
  const graph = getComputeGraph(req);
  res.json({ cells: graph.getAllCells() });
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
  const beforeDefs = {};

  for (const [name, cell] of graph.cells.entries()) {
    beforeDefs[name] = { type: cell.type, rawValue: cell.rawValue };
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
  const cell = graph.getCell(req.params.name);
  if (!cell) {
    return res.status(404).json({ error: `单元格 '${req.params.name}' 不存在` });
  }
  res.json({ cell });
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
  const { name, type, value } = req.body;
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);

  if (!name || !type || value === undefined) {
    return res.status(400).json({ error: '缺少必要参数: name, type, value' });
  }

  try {
    const { cell, changes } = graph.createCell(name, type, value);

    if (req.namespace) {
      wsManager.broadcastChangesToNamespace(req.namespace, changes);
      nsManager.propagateCrossNamespaceChange(req.namespace, [name], wsManager);
    } else {
      wsManager.broadcastChanges(changes);
    }

    audit.append('create', operator, name, null, { type, rawValue: value });
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
  const { type, value, renameTo } = req.body;
  const operator = getOperator(req);
  const graph = getComputeGraph(req);
  const audit = getAuditEngine(req);

  if (renameTo) {
    try {
      const existingCell = graph.getCell(name);
      const oldDef = existingCell ? { type: existingCell.type, rawValue: existingCell.rawValue } : null;

      const { cell, changes } = graph.renameCell(name, renameTo);

      if (req.namespace) {
        wsManager.broadcastChangesToNamespace(req.namespace, changes);
        wsManager.broadcastCellDeletedInNamespace(req.namespace, name);
      } else {
        wsManager.broadcastChanges(changes);
        wsManager.broadcastCellDeleted(name);
      }

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
    const oldDef = existingCell ? { type: existingCell.type, rawValue: existingCell.rawValue } : null;

    const { cell, changes } = graph.updateCell(name, type, value);

    if (req.namespace) {
      wsManager.broadcastChangesToNamespace(req.namespace, changes);
      nsManager.propagateCrossNamespaceChange(req.namespace, [name], wsManager);
    } else {
      wsManager.broadcastChanges(changes);
    }

    audit.append('update', operator, name, oldDef, { type, rawValue: value });
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
  const existingCell = graph.getCell(req.params.name);
  const oldDef = existingCell ? { type: existingCell.type, rawValue: existingCell.rawValue } : null;

  try {
    graph.deleteCell(req.params.name);

    if (req.namespace) {
      wsManager.broadcastCellDeletedInNamespace(req.namespace, req.params.name);
      nsManager.propagateCrossNamespaceChange(req.namespace, [req.params.name], wsManager);
    } else {
      wsManager.broadcastCellDeleted(req.params.name);
    }

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

  if (!Array.isArray(cells)) {
    return res.status(400).json({ error: 'cells 必须是数组' });
  }

  const beforeDefs = {};
  for (const [name, cell] of graph.cells.entries()) {
    beforeDefs[name] = { type: cell.type, rawValue: cell.rawValue };
  }

  try {
    const { changes, errors } = graph.batchCreateOrUpdate(cells);

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

    res.json({ success: true, changes, errors });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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

  const targetSnapshot = snapMgr.getSnapshot(req.params.id);
  if (!targetSnapshot) {
    return res.status(404).json({ error: '快照不存在' });
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

app.post('/api/namespaces', (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: '缺少必要参数: name' });
  }
  try {
    const ns = nsManager.createNamespace(name);
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
  res.json({ cells: ns.computeGraph.getAllCells() });
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

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

loadDemoData();
loadDemoNamespaces();
loadDemoTemplate();

server.listen(PORT, () => {
  console.log(`表达式求值沙盘后端已启动`);
  console.log(`HTTP 服务器: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  console.log(`演示数据已加载: ${demoCells.length} 个单元格`);
  console.log(`演示命名空间已加载: ${demoNamespaces.length} 个`);
  console.log(`模板市场已启用 (最多 ${templateManager.constructor.MAX_TEMPLATES || 100} 个模板)`);
  console.log(`管理员密钥已配置 (ADMIN_KEY 环境变量${ADMIN_KEY === 'admin-secret-key' ? '，使用默认值' : ''})`);
});
