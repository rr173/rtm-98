const WebSocket = require('ws');

class WebSocketManager {
  constructor(computeGraph) {
    this.computeGraph = computeGraph;
    this.wss = null;
    this.clients = new Map();
    this.clientId = 0;
    this.nsManager = null;
  }

  setNamespaceManager(nsManager) {
    this.nsManager = nsManager;
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
          ws.send(JSON.stringify({
            type: 'init',
            data: {
              cells: ns.computeGraph.getAllCells(),
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
        ws.send(JSON.stringify({
          type: 'init',
          data: {
            cells: this.computeGraph.getAllCells(),
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

  broadcastChanges(changes, sourceClientId = null) {
    if (changes.length === 0) return;
    const message = JSON.stringify({ type: 'batch', data: { changes } });
    for (const info of this.clients.values()) {
      if (!info.namespace && info.ws.readyState === WebSocket.OPEN) {
        info.ws.send(message);
      }
    }
  }

  broadcastChangesToNamespace(namespace, changes) {
    if (changes.length === 0) return;
    const message = JSON.stringify({ type: 'batch', data: { changes, namespace } });
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
    const message = JSON.stringify({
      type: 'restore',
      data: { cells: this.computeGraph.getAllCells() }
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
    const message = JSON.stringify({
      type: 'restore',
      data: { cells: ns.computeGraph.getAllCells(), namespace }
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
}

module.exports = { WebSocketManager };
