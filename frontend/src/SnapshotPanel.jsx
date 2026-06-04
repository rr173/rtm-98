import React, { useState, useEffect } from 'react';
import { fetchSnapshots, deleteSnapshot, restoreSnapshot, compareSnapshots } from './api.js';

export default function SnapshotPanel({ isOpen, onClose, onCompare, onRefresh, showNotification }) {
  const [snapshots, setSnapshots] = useState([]);
  const [selectedSnapshots, setSelectedSnapshots] = useState(new Set());
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadSnapshots();
    }
  }, [isOpen, onRefresh]);

  const loadSnapshots = async () => {
    setIsLoading(true);
    try {
      const data = await fetchSnapshots();
      setSnapshots(data.reverse());
    } catch (e) {
      showNotification('加载快照失败: ' + e.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('确定要删除此快照吗？')) return;

    try {
      await deleteSnapshot(id);
      setSnapshots(prev => prev.filter(s => s.id !== id));
      setSelectedSnapshots(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      showNotification('快照已删除', 'success');
    } catch (e) {
      showNotification('删除失败: ' + e.message, 'error');
    }
  };

  const handleRestore = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('确定要恢复到此快照吗？当前状态将被覆盖。')) return;

    try {
      await restoreSnapshot(id);
      showNotification('已恢复到快照状态', 'success');
      onClose();
    } catch (e) {
      showNotification('恢复失败: ' + e.message, 'error');
    }
  };

  const handleSelect = (id) => {
    setSelectedSnapshots(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 2) {
          next.delete(next.values().next().value);
        }
        next.add(id);
      }
      return next;
    });
  };

  const handleCompare = async () => {
    const ids = Array.from(selectedSnapshots);
    if (ids.length !== 2) return;

    try {
      const diff = await compareSnapshots(ids[0], ids[1]);
      onCompare(diff);
      onClose();
    } catch (e) {
      showNotification('对比失败: ' + e.message, 'error');
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  if (!isOpen) return null;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer-panel" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>📸 快照管理</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="drawer-content">
          {isLoading ? (
            <div className="snapshot-loading">加载中...</div>
          ) : snapshots.length === 0 ? (
            <div className="snapshot-empty">
              <p>暂无快照</p>
              <p className="hint">点击顶部 📸 按钮创建快照</p>
            </div>
          ) : (
            <div className="snapshot-list">
              {snapshots.map(snapshot => (
                <div
                  key={snapshot.id}
                  className={`snapshot-item ${selectedSnapshots.has(snapshot.id) ? 'selected' : ''}`}
                  onClick={() => handleSelect(snapshot.id)}
                >
                  <div className="snapshot-info">
                    <div className="snapshot-label">{snapshot.label}</div>
                    <div className="snapshot-meta">
                      <span>#{snapshot.id}</span>
                      <span>{formatTime(snapshot.timestamp)}</span>
                      <span>{snapshot.cellCount} 个单元格</span>
                    </div>
                  </div>
                  <div className="snapshot-actions">
                    <button
                      className="btn-secondary btn-sm"
                      onClick={(e) => handleRestore(snapshot.id, e)}
                    >
                      恢复
                    </button>
                    <button
                      className="btn-danger btn-sm"
                      onClick={(e) => handleDelete(snapshot.id, e)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {selectedSnapshots.size === 2 && (
          <div className="drawer-footer">
            <button className="btn-primary" onClick={handleCompare}>
              对比选中的两个快照
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
