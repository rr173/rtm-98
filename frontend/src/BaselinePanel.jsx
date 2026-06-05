import React, { useState, useEffect } from 'react';
import {
  createBaseline,
  fetchBaselines,
  deleteBaseline,
  checkBaseline,
  checkAllBaselines,
  blameBaseline
} from './api.js';

export default function BaselinePanel({
  isOpen,
  onClose,
  onHighlightPath,
  showNotification,
  refreshTrigger
}) {
  const [baselines, setBaselines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [checkResults, setCheckResults] = useState(new Map());
  const [expandedBaselines, setExpandedBaselines] = useState(new Set());
  const [blameResults, setBlameResults] = useState(new Map());
  const [tolerance, setTolerance] = useState(0.0001);

  useEffect(() => {
    if (isOpen) {
      loadBaselines();
    }
  }, [isOpen, refreshTrigger]);

  const loadBaselines = async () => {
    setLoading(true);
    try {
      const data = await fetchBaselines();
      setBaselines(data);
    } catch (e) {
      showNotification('加载基线列表失败: ' + e.message, 'error');
    }
    setLoading(false);
  };

  const handleCreate = async () => {
    if (!newName.trim()) {
      showNotification('请输入基线名称', 'error');
      return;
    }
    try {
      await createBaseline(newName.trim(), newDesc.trim());
      setNewName('');
      setNewDesc('');
      setShowCreateForm(false);
      loadBaselines();
      showNotification('基线创建成功', 'success');
    } catch (e) {
      showNotification('创建基线失败: ' + e.message, 'error');
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`确定要删除基线 "${name}" 吗？`)) return;
    try {
      await deleteBaseline(id);
      setCheckResults(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setExpandedBaselines(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setBlameResults(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      loadBaselines();
      showNotification('基线已删除', 'success');
    } catch (e) {
      showNotification('删除基线失败: ' + e.message, 'error');
    }
  };

  const handleCheck = async (id) => {
    try {
      const result = await checkBaseline(id, tolerance);
      setCheckResults(prev => {
        const next = new Map(prev);
        next.set(id, result);
        return next;
      });
      setExpandedBaselines(prev => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      showNotification(
        result.passed ? '检测通过 ✓' : `检测失败: ${result.summary.changed + result.summary.added + result.summary.removed} 处差异`,
        result.passed ? 'success' : 'error'
      );
    } catch (e) {
      showNotification('检测失败: ' + e.message, 'error');
    }
  };

  const handleCheckAll = async () => {
    try {
      const results = await checkAllBaselines(tolerance);
      const resultMap = new Map();
      results.forEach(r => {
        if (r.passed !== undefined) {
          resultMap.set(r.id, r);
        }
      });
      setCheckResults(resultMap);
      const passed = results.filter(r => r.passed).length;
      showNotification(`批量检测完成: ${passed}/${results.length} 通过`, passed === results.length ? 'success' : 'warning');
    } catch (e) {
      showNotification('批量检测失败: ' + e.message, 'error');
    }
  };

  const handleBlame = async (id) => {
    try {
      const result = await blameBaseline(id, tolerance);
      setBlameResults(prev => {
        const next = new Map(prev);
        next.set(id, result);
        return next;
      });
      setExpandedBaselines(prev => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      showNotification(`归因分析完成，发现 ${result.length} 处变更`, 'success');
    } catch (e) {
      showNotification('归因分析失败: ' + e.message, 'error');
    }
  };

  const toggleExpand = (id) => {
    setExpandedBaselines(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const highlightBlamePath = (blame) => {
    if (onHighlightPath && blame.path) {
      onHighlightPath(blame.path);
    }
  };

  const formatValue = (val) => {
    if (!val) return 'null';
    if (val.type === 'number') return val.value;
    if (val.type === 'string') return `"${val.value}"`;
    return JSON.stringify(val);
  };

  const formatDiff = (diff) => {
    if (!diff || typeof diff === 'string') return diff;
    if (diff.absolute !== undefined) {
      return `Δ=${diff.absolute.toFixed(4)} (${diff.relativePercent.toFixed(4)}%)`;
    }
    return JSON.stringify(diff);
  };

  const formatDate = (ts) => {
    return new Date(ts).toLocaleString();
  };

  if (!isOpen) return null;

  return (
    <div className="baseline-panel-overlay" onClick={onClose}>
      <div className="baseline-panel" onClick={e => e.stopPropagation()}>
        <div className="baseline-panel-header">
          <h2>基线管理 & 回归检测</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>

        <div className="baseline-panel-toolbar">
          <div className="tolerance-input">
            <label>容差:</label>
            <input
              type="number"
              step="0.0001"
              value={tolerance}
              onChange={e => setTolerance(parseFloat(e.target.value) || 0)}
            />
          </div>
          <button className="btn-secondary" onClick={handleCheckAll}>
            🔍 全部检测
          </button>
          <button className="btn-primary" onClick={() => setShowCreateForm(true)}>
            + 新建基线
          </button>
        </div>

        {showCreateForm && (
          <div className="create-baseline-form">
            <input
              type="text"
              placeholder="基线名称"
              value={newName}
              onChange={e => setNewName(e.target.value)}
            />
            <input
              type="text"
              placeholder="描述（可选）"
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
            />
            <button className="btn-primary" onClick={handleCreate}>创建</button>
            <button className="btn-secondary" onClick={() => setShowCreateForm(false)}>取消</button>
          </div>
        )}

        <div className="baseline-list">
          {loading ? (
            <div className="loading">加载中...</div>
          ) : baselines.length === 0 ? (
            <div className="empty-state">
              暂无基线，点击"新建基线"创建第一条
            </div>
          ) : (
            baselines.map(baseline => {
              const checkResult = checkResults.get(baseline.id);
              const blameResult = blameResults.get(baseline.id);
              const isExpanded = expandedBaselines.has(baseline.id);

              return (
                <div key={baseline.id} className="baseline-item">
                  <div className="baseline-item-header">
                    <div className="baseline-info" onClick={() => toggleExpand(baseline.id)}>
                      <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                      <span className="baseline-name">{baseline.name}</span>
                      {checkResult && (
                        <span className={`baseline-status ${checkResult.passed ? 'pass' : 'fail'}`}>
                          {checkResult.passed ? '✓ 通过' : '✗ 失败'}
                        </span>
                      )}
                    </div>
                    <div className="baseline-meta">
                      <span>{baseline.cellCount} 单元格</span>
                      <span>{formatDate(baseline.createdAt)}</span>
                      <button
                        className="btn-sm btn-secondary"
                        onClick={() => handleCheck(baseline.id)}
                      >
                        检测
                      </button>
                      <button
                        className="btn-sm btn-secondary"
                        onClick={() => handleBlame(baseline.id)}
                      >
                        归因
                      </button>
                      <button
                        className="btn-sm btn-danger"
                        onClick={() => handleDelete(baseline.id, baseline.name)}
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  {baseline.description && (
                    <div className="baseline-description">{baseline.description}</div>
                  )}

                  {isExpanded && checkResult && (
                    <div className="baseline-details">
                      <div className="check-summary">
                        <span>总计: {checkResult.summary.total}</span>
                        <span className="unchanged">未变: {checkResult.summary.unchanged}</span>
                        <span className="changed">变更: {checkResult.summary.changed}</span>
                        <span className="added">新增: {checkResult.summary.added}</span>
                        <span className="removed">删除: {checkResult.summary.removed}</span>
                      </div>

                      {checkResult.details.length > 0 && (
                        <div className="diff-list">
                          <h4>差异详情</h4>
                          {checkResult.details.map((detail, idx) => (
                            <div key={idx} className={`diff-item ${detail.changeType}`}>
                              <div className="diff-cell-name">
                                <span className={`change-badge ${detail.changeType}`}>
                                  {detail.changeType === 'added' ? '+' : detail.changeType === 'removed' ? '-' : '~'}
                                </span>
                                {detail.name}
                                {detail.withinTolerance && (
                                  <span className="tolerance-badge">容差内</span>
                                )}
                              </div>
                              <div className="diff-values">
                                {detail.changeType !== 'added' && (
                                  <span className="baseline-val">基线: {formatValue(detail.baselineValue)}</span>
                                )}
                                {detail.changeType !== 'removed' && (
                                  <span className="current-val">当前: {formatValue(detail.currentValue)}</span>
                                )}
                                {detail.changeType === 'modified' && (
                                  <span className="diff-val">{formatDiff(detail.diff)}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {blameResult && blameResult.length > 0 && (
                        <div className="blame-list">
                          <h4>变更归因</h4>
                          {blameResult.map((blame, idx) => (
                            <div
                              key={idx}
                              className="blame-item"
                              onMouseEnter={() => highlightBlamePath(blame)}
                            >
                              <div className="blame-row">
                                <span className="blame-target">{blame.cell}</span>
                                <span className="blame-arrow">←</span>
                                <span className={`blame-source ${blame.blameType}`}>
                                  {blame.blameSource}
                                </span>
                                <span className="blame-type">({blame.blameType})</span>
                              </div>
                              <div className="blame-path">
                                路径: {blame.path.join(' → ')}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
