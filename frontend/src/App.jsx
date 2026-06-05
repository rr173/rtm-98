import React, { useState, useEffect, useRef, useCallback } from 'react';
import GraphCanvas from './GraphCanvas.jsx';
import EditModal from './EditModal.jsx';
import DetailPanel from './DetailPanel.jsx';
import SnapshotPanel from './SnapshotPanel.jsx';
import RulePanel from './RulePanel.jsx';
import { createWebSocketConnection } from './websocket.js';
import {
  fetchCells,
  createCell,
  updateCell,
  renameCell,
  deleteCell,
  exportGraph,
  importGraph,
  createSnapshot,
  compareSnapshots,
  fetchPerfCells
} from './api.js';

export default function App() {
  const [cells, setCells] = useState([]);
  const [selectedCell, setSelectedCell] = useState(null);
  const [onlineCount, setOnlineCount] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingCell, setEditingCell] = useState(null);
  const [isNewCell, setIsNewCell] = useState(false);
  const [newCellPosition, setNewCellPosition] = useState({ x: 0, y: 0 });
  const [flashingCells, setFlashingCells] = useState(new Map());
  const [notification, setNotification] = useState(null);
  const [showSnapshotPanel, setShowSnapshotPanel] = useState(false);
  const [snapshotRefresh, setSnapshotRefresh] = useState(0);
  const [diffCells, setDiffCells] = useState(new Set());
  const [showDiffLegend, setShowDiffLegend] = useState(false);
  const [perfAlert, setPerfAlert] = useState(null);
  const [heatmapEnabled, setHeatmapEnabled] = useState(false);
  const [cellPerfData, setCellPerfData] = useState(new Map());
  const [showRulePanel, setShowRulePanel] = useState(false);
  const [ruleAlerts, setRuleAlerts] = useState(new Map());
  const wsRef = useRef(null);
  const clientIdRef = useRef(null);

  const showNotification = (message, type = 'error') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  const showPerfAlert = (alert) => {
    setPerfAlert(alert);
    setTimeout(() => setPerfAlert(null), 3000);
  };

  const triggerFlash = useCallback((names) => {
    setFlashingCells(prev => {
      const next = new Map(prev);
      const now = Date.now();
      for (const name of names) {
        next.set(name, now);
      }
      return next;
    });

    setTimeout(() => {
      setFlashingCells(prev => {
        const next = new Map(prev);
        for (const name of names) {
          next.delete(name);
        }
        return next;
      });
    }, 600);
  }, []);

  const handleWebSocketMessage = useCallback((message) => {
    switch (message.type) {
      case 'init':
        clientIdRef.current = message.data.clientId;
        setCells(message.data.cells);
        setOnlineCount(message.data.onlineCount);
        setIsConnected(true);
        break;

      case 'restore':
        setCells(message.data.cells);
        setSelectedCell(null);
        setDiffCells(new Set());
        setShowDiffLegend(false);
        setSnapshotRefresh(prev => prev + 1);
        break;

      case 'batch': {
        const changes = message.data.changes;
        if (changes && changes.length > 0) {
          setCells(prev => {
            const updated = new Map(prev.map(c => [c.name, { ...c }]));
            for (const change of changes) {
              if (updated.has(change.name)) {
                const cell = updated.get(change.name);
                cell.value = { type: typeof change.newValue === 'number' ? 'number' : 'string', value: change.newValue };
                cell.computeTimeMs = change.computeTimeMs;
                cell.error = null;
              }
            }
            return Array.from(updated.values());
          });

          const changedNames = changes.map(c => c.name);
          triggerFlash(changedNames);

          setSelectedCell(prev => {
            if (prev && changedNames.includes(prev.name)) {
              const updatedCell = [...cells, ...changes.map(c => ({
                name: c.name,
                value: { type: typeof c.newValue === 'number' ? 'number' : 'string', value: c.newValue },
                computeTimeMs: c.computeTimeMs
              }))].find(c => c.name === prev.name);
              return updatedCell || prev;
            }
            return prev;
          });
        }
        break;
      }

      case 'delete': {
        const name = message.data.name;
        setCells(prev => prev.filter(c => c.name !== name));
        setSelectedCell(prev => (prev && prev.name === name ? null : prev));
        break;
      }

      case 'online':
        setOnlineCount(message.data.count);
        break;

      case 'perf_alert':
        showPerfAlert(message);
        break;

      case 'rule_alert':
        setRuleAlerts(prev => {
          const next = new Map(prev);
          next.set(message.cellName, {
            message: message.message,
            timestamp: message.timestamp
          });
          return next;
        });
        setTimeout(() => {
          setRuleAlerts(prev => {
            const next = new Map(prev);
            next.delete(message.cellName);
            return next;
          });
        }, 3000);
        break;

      default:
        break;
    }
  }, [cells, triggerFlash]);

  useEffect(() => {
    const init = async () => {
      try {
        const initialCells = await fetchCells();
        setCells(initialCells);
      } catch (e) {
        console.error('加载初始数据失败:', e);
      }

      const ws = createWebSocketConnection(
        handleWebSocketMessage,
        () => setIsConnected(true),
        () => setIsConnected(false),
        (e) => console.error('WebSocket 错误:', e)
      );
      wsRef.current = ws;

      return () => {
        if (ws) ws.close();
      };
    };

    init();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setFlashingCells(prev => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        const now = Date.now();
        for (const [name, time] of next) {
          if (now - time > 500) {
            next.delete(name);
          }
        }
        return next;
      });
    }, 100);

    return () => clearInterval(interval);
  }, []);

  const handleSelectCell = useCallback((cellOrName) => {
    if (typeof cellOrName === 'string') {
      const cell = cells.find(c => c.name === cellOrName);
      setSelectedCell(cell);
    } else {
      setSelectedCell(cellOrName);
    }
  }, [cells]);

  const handleNodeDoubleClick = useCallback((cell) => {
    setEditingCell(cell);
    setIsNewCell(false);
    setShowModal(true);
  }, []);

  const handleBackgroundDoubleClick = useCallback((x, y) => {
    setNewCellPosition({ x, y });
    setEditingCell(null);
    setIsNewCell(true);
    setShowModal(true);
  }, []);

  const handleSaveCell = async (name, type, value) => {
    try {
      if (isNewCell) {
        await createCell(name, type, value);
      } else {
        await updateCell(editingCell.name, type, value);
      }
      setShowModal(false);
    } catch (e) {
      showNotification(e.message, 'error');
    }
  };

  const handleRename = async (oldName, newName) => {
    try {
      await renameCell(oldName, newName);
      setShowModal(false);
    } catch (e) {
      showNotification(e.message, 'error');
    }
  };

  const handleDelete = async (name) => {
    try {
      await deleteCell(name);
      setShowModal(false);
      if (selectedCell && selectedCell.name === name) {
        setSelectedCell(null);
      }
    } catch (e) {
      showNotification(e.message, 'error');
    }
  };

  const handleExport = async () => {
    try {
      const data = await exportGraph();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `graph-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      showNotification('导出失败: ' + e.message, 'error');
    }
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await importGraph(data);
        showNotification('导入成功', 'success');
      } catch (e) {
        showNotification('导入失败: ' + e.message, 'error');
      }
    };
    input.click();
  };

  const handleReset = async () => {
    if (!window.confirm('确定要清空所有单元格吗？')) return;

    try {
      await importGraph({ cells: [] });
      showNotification('已清空', 'success');
    } catch (e) {
      showNotification('清空失败: ' + e.message, 'error');
    }
  };

  const handleRefresh = async () => {
    try {
      const data = await fetchCells();
      setCells(data);
      showNotification('已刷新', 'success');
    } catch (e) {
      showNotification('刷新失败: ' + e.message, 'error');
    }
  };

  const handleCreateSnapshot = async () => {
    const label = window.prompt('请输入快照标签（可选）:');
    if (label === null) return;

    try {
      const snapshot = await createSnapshot(label);
      setSnapshotRefresh(prev => prev + 1);
      showNotification(`快照 #${snapshot.id} 已创建`, 'success');
    } catch (e) {
      showNotification('创建快照失败: ' + e.message, 'error');
    }
  };

  const handleCompare = (diff) => {
    const changedNames = new Set();
    diff.added.forEach(name => changedNames.add(name));
    diff.deleted.forEach(name => changedNames.add(name));
    diff.modified.forEach(m => changedNames.add(m.name));
    setDiffCells(changedNames);
    setShowDiffLegend(true);
    showNotification(`对比完成: ${diff.added.length} 新增, ${diff.deleted.length} 删除, ${diff.modified.length} 修改`, 'success');
  };

  const handleClearDiff = () => {
    setDiffCells(new Set());
    setShowDiffLegend(false);
  };

  const handleCompareWithCurrent = async () => {
    const label = window.prompt('请输入要对比的快照ID:');
    if (!label) return;

    try {
      const diff = await compareSnapshots('current', label);
      handleCompare(diff);
    } catch (e) {
      showNotification('对比失败: ' + e.message, 'error');
    }
  };

  const loadCellPerfData = async () => {
    try {
      const perfCells = await fetchPerfCells();
      const perfMap = new Map(perfCells.map(p => [p.name, p]));
      setCellPerfData(perfMap);
    } catch (e) {
      console.error('加载性能数据失败:', e);
    }
  };

  const toggleHeatmap = async () => {
    if (!heatmapEnabled) {
      await loadCellPerfData();
    }
    setHeatmapEnabled(prev => !prev);
  };

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>表达式求值沙盘</h1>
          <div className="connection-status">
            <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
            <span>{isConnected ? '已连接' : '未连接'}</span>
            <span className="online-count">
              在线: {onlineCount}
            </span>
          </div>
        </div>
        <div className="header-right">
          <button 
            className={`btn-secondary ${heatmapEnabled ? 'active' : ''}`} 
            onClick={toggleHeatmap} 
            title="性能热力图"
            style={{ background: heatmapEnabled ? '#fef3c7' : undefined }}
          >
            🔥
          </button>
          <button className="btn-secondary" onClick={handleCreateSnapshot} title="创建快照">📸</button>
          <button className="btn-secondary" onClick={() => setShowSnapshotPanel(true)} title="快照管理">🕐</button>
          <button className="btn-secondary" onClick={() => setShowRulePanel(true)} title="规则管理">⚡</button>
          <button className="btn-secondary" onClick={handleRefresh}>刷新</button>
          <button className="btn-secondary" onClick={handleExport}>导出</button>
          <button className="btn-secondary" onClick={handleImport}>导入</button>
          <button className="btn-danger" onClick={handleReset}>清空</button>
        </div>
      </header>

      <div className="app-body">
        <div className="main-area">
          <GraphCanvas
            cells={cells}
            selectedCell={selectedCell}
            onSelectCell={handleSelectCell}
            onNodeDoubleClick={handleNodeDoubleClick}
            onBackgroundDoubleClick={handleBackgroundDoubleClick}
            flashingCells={flashingCells}
            diffCells={diffCells}
            heatmapEnabled={heatmapEnabled}
            cellPerfData={cellPerfData}
            ruleAlerts={ruleAlerts}
          />
        </div>
        <DetailPanel
          cell={selectedCell}
          onSelectCell={handleSelectCell}
        />
      </div>

      <div className="legend">
        <div className="legend-item">
          <span className="legend-box constant" />
          <span>常量 (蓝色边框)</span>
        </div>
        <div className="legend-item">
          <span className="legend-box formula" />
          <span>表达式 (绿色边框)</span>
        </div>
        <div className="legend-item">
          <span className="legend-box flashing" />
          <span>刚更新 (黄色闪烁)</span>
        </div>
        <div className="legend-item">
          <span className="legend-box selected" />
          <span>选中 (橙色边框)</span>
        </div>
        {showDiffLegend && (
          <>
            <div className="legend-item">
              <span className="legend-box diff" />
              <span>有差异 (橙色边框)</span>
            </div>
            <button className="btn-sm btn-secondary" onClick={handleClearDiff} style={{ marginLeft: '8px' }}>
              清除对比
            </button>
          </>
        )}
      </div>

      <SnapshotPanel
        isOpen={showSnapshotPanel}
        onClose={() => setShowSnapshotPanel(false)}
        onCompare={handleCompare}
        onRefresh={snapshotRefresh}
        showNotification={showNotification}
      />

      {notification && (
        <div className={`notification ${notification.type}`}>
          {notification.message}
        </div>
      )}

      {perfAlert && (
        <div className="perf-alert-toast">
          <div className="perf-alert-title">
            <span className="perf-alert-icon">⚠️</span>
            <span>慢计算告警</span>
          </div>
          <div className="perf-alert-content">
            <div>触发源: {perfAlert.trigger}</div>
            <div>总耗时: <strong>{perfAlert.totalMs}ms</strong></div>
            <div>节点数: {perfAlert.nodeCount}</div>
            <div className="perf-alert-slowest">
              最慢节点:
              {perfAlert.slowest?.map?.((s, i) => (
                <span key={i} className="perf-alert-node">
                  {s.name} ({s.durationMs}ms)
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <RulePanel
        isOpen={showRulePanel}
        onClose={() => setShowRulePanel(false)}
        cells={cells}
        showNotification={showNotification}
      />

      {showModal && (
        <EditModal
          cell={editingCell}
          isNew={isNewCell}
          defaultX={newCellPosition.x}
          defaultY={newCellPosition.y}
          onSave={handleSaveCell}
          onDelete={handleDelete}
          onRename={handleRename}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
