const WebSocket = require('ws');

class WebSocketManager {
  constructor(computeGraph) {
    this.computeGraph = computeGraph;
    this.wss = null;
    this.clients = new Map();
    this.clientId = 0;
    this.nsManager = null;
    this.globalLockManager = null;
  }

  setNamespaceManager(nsManager) {
    this.nsManager = nsManager;
  }

  setGlobalLockManager(lockManager) {
    this.globalLockManager = lockManager;
  }

  attach(server) {
    this.wss = new WebSocket.Server({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const id = ++this.clientId;
      const url = new URL(req.url, `http://${req.headers.host}`);
      const namespace = url.searchParams.get('namespace') || null;

      const clientInfo = { ws, namespace };
      this.clients.set(id, clientInfo);

      console.log(`客户端 ${id} 连接 (namespace: ${namespace || 'global'})，当前在线: ${this.clients.size}`);

      if (namespace && this.nsManager) {
        const ns = this.nsManager.getNamespace(namespace);
        if (ns) {
          const cellsWithLocks = this._augmentCellsWithLockInfo(ns.computeGraph.getAllCells(), namespace);
          ws.send(JSON.stringify({
            type: 'init',
            data: {
              cells: cellsWithLocks,
              clientId: id,
              onlineCount: this.getNamespaceOnlineCount(namespace),
              namespace
            }
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'init',
            data: {
              cells: [],
              clientId: id,
              onlineCount: 1,
              namespace,
              error: `命名空间 '${namespace}' 不存在`
            }
          }));
        }
      } else {
        const cellsWithLocks = this._augmentCellsWithLockInfo(this.computeGraph.getAllCells(), null);
        ws.send(JSON.stringify({
          type: 'init',
          data: {
            cells: cellsWithLocks,
            clientId: id,
            onlineCount: this.getOnlineCount(),
            namespace: null
          }
        }));
      }

      this.broadcastOnlineCount(namespace);

      ws.on('close', () => {
        this.clients.delete(id);
        console.log(`客户端 ${id} 断开，当前在线: ${this.clients.size}`);
        this.broadcastOnlineCount(namespace);
      });

      ws.on('error', (err) => {
        console.error(`客户端 ${id} 错误:`, err.message);
      });
    });
  }

  getNamespaceOnlineCount(namespace) {
    let count = 0;
    for (const info of this.clients.values()) {
      if (info.namespace === namespace) count++;
    }
    return count;
  }

  broadcastOnlineCount(namespace) {
    if (namespace) {
      const count = this.getNamespaceOnlineCount(namespace);
      const message = JSON.stringify({ type: 'online', data: { count, namespace } });
      for (const info of this.clients.values()) {
        if (info.namespace === namespace && info.ws.readyState === WebSocket.OPEN) {
          info.ws.send(message);
        }
      }
    } else {
      const message = JSON.stringify({ type: 'online', data: { count: this.getOnlineCount() } });
      for (const info of this.clients.values()) {
        if (!info.namespace && info.ws.readyState === WebSocket.OPEN) {
          info.ws.send(message);
        }
      }
    }
  }

  sanitizeChangesForBroadcast(changes) {
    return changes.map(change => {
      if (change.lazy && change.status === 'dirty') {
        return { name: change.name, status: 'dirty' };
      }
      return change;
    });
  }

  _getLockManagerForNamespace(namespace) {
    if (namespace && this.nsManager) {
      const ns = this.nsManager.getNamespace(namespace);
      if (ns) return ns.lockManager;
    }
    return this.globalLockManager;
  }

  _augmentCellsWithLockInfo(cells, namespace) {
    const lockManager = this._getLockManagerForNamespace(namespace);
    if (!lockManager) return cells;
    return cells.map(cell => {
      const lockInfo = lockManager.getLockInfo(cell.name);
      if (lockInfo) {
        return {
          ...cell,
          locked: true,
          lockedBy: lockInfo.lockedBy
        };
      }
      return {
        ...cell,
        locked: false,
        lockedBy: null
      };
    });
  }

  broadcastChanges(changes, sourceClientId = null) {
    if (changes.length === 0) return;
    const sanitized = this.sanitizeChangesForBroadcast(changes);
    const message = JSON.stringify({ type: 'batch', data: { changes: sanitized } });
    for (const info of this.clients.values()) {
      if (!info.namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastChangesToNamespace(namespace, changes) {
    if (changes.length === 0) return;
    const sanitized = this.sanitizeChangesForBroadcast(changes);
    const message = JSON.stringify({ type: 'batch', data: { changes: sanitized, namespace } });
    for (const info of this.clients.values()) {
      if (info.namespace === namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastCellDeleted(name) {
    const message = JSON.stringify({ type: 'delete', data: { name } });
    for (const info of this.clients.values()) {
      if (!info.namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastCellDeletedInNamespace(namespace, name) {
    const message = JSON.stringify({ type: 'delete', data: { name, namespace } });
    for (const info of this.clients.values()) {
      if (info.namespace === namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastRestore() {
    const cellsWithLocks = this._augmentCellsWithLockInfo(this.computeGraph.getAllCells(), null);
    const message = JSON.stringify({
      type: 'restore',
      data: { cells: cellsWithLocks }
    });
    for (const info of this.clients.values()) {
      if (!info.namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastRestoreToNamespace(namespace) {
    const ns = this.nsManager ? this.nsManager.getNamespace(namespace) : null;
    if (!ns) return;
    const cellsWithLocks = this._augmentCellsWithLockInfo(ns.computeGraph.getAllCells(), namespace);
    const message = JSON.stringify({
      type: 'restore',
      data: { cells: cellsWithLocks, namespace }
    });
    for (const info of this.clients.values()) {
      if (info.namespace === namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  getOnlineCount() {
    let count = 0;
    for (const info of this.clients.values()) {
      if (!info.namespace) count++;
    }
    return count;
  }

  broadcastPerfAlert(alertData, namespace = null) {
    const message = JSON.stringify({
      type: 'perf_alert',
      totalMs: alertData.totalMs,
      trigger: alertData.trigger,
      slowest: alertData.slowest,
      nodeCount: alertData.nodeCount,
      timestamp: alertData.timestamp
    });

    for (const info of this.clients.values()) {
      const shouldSend = namespace 
        ? info.namespace === namespace 
        : !info.namespace;
      
      if (shouldSend && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastRuleAlert(alertData) {
    const message = JSON.stringify({
      type: 'rule_alert',
      ruleId: alertData.ruleId,
      cellName: alertData.cellName,
      message: alertData.message,
      currentValue: alertData.currentValue,
      timestamp: alertData.timestamp
    });

    for (const info of this.clients.values()) {
      if (!info.namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastRuleAlertToNamespace(namespace, alertData) {
    const message = JSON.stringify({
      type: 'rule_alert',
      ruleId: alertData.ruleId,
      cellName: alertData.cellName,
      message: alertData.message,
      currentValue: alertData.currentValue,
      timestamp: alertData.timestamp,
      namespace
    });

    for (const info of this.clients.values()) {
      if (info.namespace === namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastScheduleExecution(executionData) {
    const message = JSON.stringify({
      type: 'schedule_executed',
      scheduleId: executionData.scheduleId,
      name: executionData.name,
      status: executionData.status,
      timestamp: executionData.timestamp,
      actionResults: executionData.actionResults
    });

    for (const info of this.clients.values()) {
      if (!info.namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastScheduleExecutionToNamespace(namespace, executionData) {
    const message = JSON.stringify({
      type: 'schedule_executed',
      scheduleId: executionData.scheduleId,
      name: executionData.name,
      status: executionData.status,
      timestamp: executionData.timestamp,
      actionResults: executionData.actionResults,
      namespace
    });

    for (const info of this.clients.values()) {
      if (info.namespace === namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastScheduleAlert(alertData) {
    const message = JSON.stringify({
      type: 'schedule_alert',
      scheduleId: alertData.scheduleId,
      name: alertData.name,
      message: alertData.message,
      baselineId: alertData.baselineId,
      diff: alertData.diff,
      timestamp: alertData.timestamp
    });

    for (const info of this.clients.values()) {
      if (!info.namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastScheduleAlertToNamespace(namespace, alertData) {
    const message = JSON.stringify({
      type: 'schedule_alert',
      scheduleId: alertData.scheduleId,
      name: alertData.name,
      message: alertData.message,
      baselineId: alertData.baselineId,
      diff: alertData.diff,
      timestamp: alertData.timestamp,
      namespace
    });

    for (const info of this.clients.values()) {
      if (info.namespace === namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastCellLocked(cellName, lockedBy, expiresAt, namespace = null) {
    const message = JSON.stringify({
      type: 'cell_locked',
      name: cellName,
      lockedBy,
      expiresAt,
      namespace
    });

    for (const info of this.clients.values()) {
      const shouldSend = namespace
        ? info.namespace === namespace
        : !info.namespace;
      if (shouldSend && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastCellUnlocked(cellName, namespace = null) {
    const message = JSON.stringify({
      type: 'cell_unlocked',
      name: cellName,
      namespace
    });

    for (const info of this.clients.values()) {
      const shouldSend = namespace
        ? info.namespace === namespace
        : !info.namespace;
      if (shouldSend && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }
}

module.exports = { WebSocketManager };
