import React, { useState, useEffect } from 'react';
import {
  createSchedule,
  fetchSchedules,
  fetchSchedule,
  fetchScheduleHistory,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  validateCron
} from './api.js';

const ACTION_TYPES = [
  { value: 'set_value', label: '修改单元格值' },
  { value: 'snapshot', label: '拍快照' },
  { value: 'check_baseline', label: '基线回归检测' },
  { value: 'run_sandbox', label: '执行沙箱脚本' }
];

const VALUE_MODES = [
  { value: 'fixed', label: '固定值' },
  { value: 'random', label: '随机值' },
  { value: 'sequence', label: '序列值' }
];

export default function SchedulePanel({
  isOpen,
  onClose,
  showNotification
}) {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedSchedules, setExpandedSchedules] = useState(new Set());
  const [scheduleDetails, setScheduleDetails] = useState(new Map());
  const [scheduleHistory, setScheduleHistory] = useState(new Map());

  const [newName, setNewName] = useState('');
  const [newCron, setNewCron] = useState('*/10 * * * * *');
  const [cronValid, setCronValid] = useState(true);
  const [cronError, setCronError] = useState('');
  const [newEnabled, setNewEnabled] = useState(true);
  const [actions, setActions] = useState([]);

  useEffect(() => {
    if (isOpen) {
      loadSchedules();
    }
  }, [isOpen]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (newCron) {
        checkCron(newCron);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [newCron]);

  const checkCron = async (expression) => {
    try {
      const result = await validateCron(expression);
      setCronValid(result.valid);
      setCronError(result.error || '');
    } catch (e) {
      setCronValid(false);
      setCronError(e.message);
    }
  };

  const loadSchedules = async () => {
    setLoading(true);
    try {
      const data = await fetchSchedules();
      setSchedules(data);
    } catch (e) {
      showNotification('加载调度列表失败: ' + e.message, 'error');
    }
    setLoading(false);
  };

  const handleCreate = async () => {
    if (!newName.trim()) {
      showNotification('请输入任务名称', 'error');
      return;
    }
    if (!cronValid) {
      showNotification('cron表达式无效', 'error');
      return;
    }

    try {
      await createSchedule({
        name: newName.trim(),
        cron: newCron,
        enabled: newEnabled,
        actions: actions.map(a => buildAction(a))
      });
      resetForm();
      setShowCreateForm(false);
      loadSchedules();
      showNotification('调度任务创建成功', 'success');
    } catch (e) {
      showNotification('创建失败: ' + e.message, 'error');
    }
  };

  const buildAction = (action) => {
    const base = { type: action.type };
    switch (action.type) {
      case 'set_value':
        base.cell = action.cell;
        if (action.valueMode === 'fixed') {
          base.value = action.fixedValue;
        } else if (action.valueMode === 'random') {
          base.value = {
            random: true,
            min: Number(action.randomMin),
            max: Number(action.randomMax)
          };
        } else if (action.valueMode === 'sequence') {
          base.value = {
            sequence: action.sequenceValues.split(',').map(v => Number(v.trim())),
            loop: action.sequenceLoop
          };
        }
        break;
      case 'snapshot':
        base.label = action.label || 'auto-${timestamp}';
        break;
      case 'check_baseline':
        base.baselineId = Number(action.baselineId);
        break;
      case 'run_sandbox':
        base.instructions = action.instructions;
        break;
    }
    return base;
  };

  const resetForm = () => {
    setNewName('');
    setNewCron('*/10 * * * * *');
    setNewEnabled(true);
    setActions([]);
    setCronValid(true);
    setCronError('');
  };

  const addAction = () => {
    setActions([...actions, {
      type: 'set_value',
      cell: '',
      valueMode: 'fixed',
      fixedValue: 0,
      randomMin: 0,
      randomMax: 100,
      sequenceValues: '1,2,3',
      sequenceLoop: true,
      label: 'auto-${timestamp}',
      baselineId: 1,
      instructions: []
    }]);
  };

  const removeAction = (index) => {
    setActions(actions.filter((_, i) => i !== index));
  };

  const updateAction = (index, field, value) => {
    const newActions = [...actions];
    newActions[index] = { ...newActions[index], [field]: value };
    setActions(newActions);
  };

  const toggleExpand = async (id) => {
    const newExpanded = new Set(expandedSchedules);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
      try {
        const detail = await fetchSchedule(id);
        setScheduleDetails(prev => {
          const next = new Map(prev);
          next.set(id, detail);
          return next;
        });
        const history = await fetchScheduleHistory(id);
        setScheduleHistory(prev => {
          const next = new Map(prev);
          next.set(id, history);
          return next;
        });
      } catch (e) {
        showNotification('加载详情失败: ' + e.message, 'error');
      }
    }
    setExpandedSchedules(newExpanded);
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`确定要删除调度任务 "${name}" 吗？`)) return;
    try {
      await deleteSchedule(id);
      setExpandedSchedules(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      loadSchedules();
      showNotification('调度任务已删除', 'success');
    } catch (e) {
      showNotification('删除失败: ' + e.message, 'error');
    }
  };

  const handlePause = async (id) => {
    try {
      await pauseSchedule(id);
      loadSchedules();
      showNotification('调度已暂停', 'success');
    } catch (e) {
      showNotification('暂停失败: ' + e.message, 'error');
    }
  };

  const handleResume = async (id) => {
    try {
      await resumeSchedule(id);
      loadSchedules();
      showNotification('调度已恢复', 'success');
    } catch (e) {
      showNotification('恢复失败: ' + e.message, 'error');
    }
  };

  const formatDate = (ts) => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'success':
        return <span className="status-badge success">成功</span>;
      case 'partial_success':
        return <span className="status-badge warning">部分成功</span>;
      case 'failed':
        return <span className="status-badge error">失败</span>;
      default:
        return <span className="status-badge">{status}</span>;
    }
  };

  const getActionTypeLabel = (type) => {
    const found = ACTION_TYPES.find(t => t.value === type);
    return found ? found.label : type;
  };

  if (!isOpen) return null;

  return (
    <div className="baseline-panel-overlay" onClick={onClose}>
      <div className="baseline-panel" onClick={e => e.stopPropagation()}>
        <div className="baseline-panel-header">
          <h2>定时调度 & 自动化流水线</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>

        <div className="baseline-panel-toolbar">
          <button className="btn-primary" onClick={() => setShowCreateForm(true)}>
            + 新建调度任务
          </button>
        </div>

        {showCreateForm && (
          <div className="create-schedule-form">
            <h3>创建调度任务</h3>
            
            <div className="form-group">
              <label>任务名称:</label>
              <input
                type="text"
                placeholder="输入任务名称"
                value={newName}
                onChange={e => setNewName(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>Cron表达式 (秒 分 时 日 月 周):</label>
              <input
                type="text"
                value={newCron}
                onChange={e => setNewCron(e.target.value)}
                className={!cronValid ? 'input-error' : ''}
              />
              {!cronValid && <span className="error-text">{cronError}</span>}
              <div className="cron-help">
                <small>示例: */10 * * * * * (每10秒) | 0 */5 * * * * (每5分钟) | 0 0 9 * * * (每天9点)</small>
              </div>
            </div>

            <div className="form-group checkbox-group">
              <label>
                <input
                  type="checkbox"
                  checked={newEnabled}
                  onChange={e => setNewEnabled(e.target.checked)}
                />
                创建后立即启用
              </label>
            </div>

            <div className="form-group">
              <label>操作序列:</label>
              <div className="actions-list">
                {actions.map((action, idx) => (
                  <div key={idx} className="action-item">
                    <div className="action-header">
                      <span className="action-index">{idx + 1}.</span>
                      <select
                        value={action.type}
                        onChange={e => updateAction(idx, 'type', e.target.value)}
                      >
                        {ACTION_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <button
                        className="btn-sm btn-danger"
                        onClick={() => removeAction(idx)}
                      >
                        删除
                      </button>
                    </div>

                    {action.type === 'set_value' && (
                      <div className="action-fields">
                        <div className="field-row">
                          <label>单元格:</label>
                          <input
                            type="text"
                            placeholder="unit_price"
                            value={action.cell}
                            onChange={e => updateAction(idx, 'cell', e.target.value)}
                          />
                        </div>
                        <div className="field-row">
                          <label>值模式:</label>
                          <select
                            value={action.valueMode}
                            onChange={e => updateAction(idx, 'valueMode', e.target.value)}
                          >
                            {VALUE_MODES.map(m => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </select>
                        </div>
                        {action.valueMode === 'fixed' && (
                          <div className="field-row">
                            <label>固定值:</label>
                            <input
                              type="number"
                              value={action.fixedValue}
                              onChange={e => updateAction(idx, 'fixedValue', Number(e.target.value))}
                            />
                          </div>
                        )}
                        {action.valueMode === 'random' && (
                          <>
                            <div className="field-row">
                              <label>最小值:</label>
                              <input
                                type="number"
                                value={action.randomMin}
                                onChange={e => updateAction(idx, 'randomMin', e.target.value)}
                              />
                            </div>
                            <div className="field-row">
                              <label>最大值:</label>
                              <input
                                type="number"
                                value={action.randomMax}
                                onChange={e => updateAction(idx, 'randomMax', e.target.value)}
                              />
                            </div>
                          </>
                        )}
                        {action.valueMode === 'sequence' && (
                          <>
                            <div className="field-row">
                              <label>序列值(逗号分隔):</label>
                              <input
                                type="text"
                                value={action.sequenceValues}
                                onChange={e => updateAction(idx, 'sequenceValues', e.target.value)}
                              />
                            </div>
                            <div className="field-row checkbox-group">
                              <label>
                                <input
                                  type="checkbox"
                                  checked={action.sequenceLoop}
                                  onChange={e => updateAction(idx, 'sequenceLoop', e.target.checked)}
                                />
                                循环执行
                              </label>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {action.type === 'snapshot' && (
                      <div className="action-fields">
                        <div className="field-row">
                          <label>快照标签:</label>
                          <input
                            type="text"
                            value={action.label}
                            onChange={e => updateAction(idx, 'label', e.target.value)}
                            placeholder="auto-${timestamp}"
                          />
                        </div>
                        <small>支持占位符: ${'{timestamp}'}, ${'{index}'}</small>
                      </div>
                    )}

                    {action.type === 'check_baseline' && (
                      <div className="action-fields">
                        <div className="field-row">
                          <label>基线ID:</label>
                          <input
                            type="number"
                            value={action.baselineId}
                            onChange={e => updateAction(idx, 'baselineId', Number(e.target.value))}
                          />
                        </div>
                      </div>
                    )}

                    {action.type === 'run_sandbox' && (
                      <div className="action-fields">
                        <div className="field-row">
                          <label>脚本指令(JSON数组):</label>
                          <textarea
                            rows={4}
                            value={JSON.stringify(action.instructions, null, 2)}
                            onChange={e => {
                              try {
                                const parsed = JSON.parse(e.target.value);
                                updateAction(idx, 'instructions', parsed);
                              } catch (err) {
                              }
                            }}
                            placeholder='[{"op":"update","name":"cell_name","type":"constant","value":100}]'
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <button className="btn-secondary add-action-btn" onClick={addAction}>
                  + 添加操作
                </button>
              </div>
            </div>

            <div className="form-actions">
              <button className="btn-primary" onClick={handleCreate}>创建</button>
              <button className="btn-secondary" onClick={() => {
                setShowCreateForm(false);
                resetForm();
              }}>取消</button>
            </div>
          </div>
        )}

        <div className="baseline-list">
          {loading ? (
            <div className="loading">加载中...</div>
          ) : schedules.length === 0 ? (
            <div className="empty-state">
              暂无调度任务，点击"新建调度任务"创建第一个
            </div>
          ) : (
            schedules.map(schedule => {
              const isExpanded = expandedSchedules.has(schedule.id);
              const detail = scheduleDetails.get(schedule.id);
              const history = scheduleHistory.get(schedule.id);

              return (
                <div key={schedule.id} className="baseline-item">
                  <div className="baseline-item-header">
                    <div className="baseline-info" onClick={() => toggleExpand(schedule.id)}>
                      <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                      <span className="baseline-name">{schedule.name}</span>
                      <span className={`schedule-status ${schedule.paused ? 'paused' : 'running'}`}>
                        {schedule.paused ? '⏸ 已暂停' : '▶ 运行中'}
                      </span>
                    </div>
                    <div className="baseline-meta">
                      <span>{schedule.actionCount} 个操作</span>
                      <span title={schedule.cron}>{schedule.cron}</span>
                      <button
                        className="btn-sm btn-secondary"
                        onClick={() => schedule.paused ? handleResume(schedule.id) : handlePause(schedule.id)}
                      >
                        {schedule.paused ? '恢复' : '暂停'}
                      </button>
                      <button
                        className="btn-sm btn-danger"
                        onClick={() => handleDelete(schedule.id, schedule.name)}
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  <div className="schedule-meta-row">
                    <span>创建时间: {formatDate(schedule.createdAt)}</span>
                    <span>上次执行: {formatDate(schedule.lastExecution)}</span>
                    <span>下次执行: {formatDate(schedule.nextExecution)}</span>
                  </div>

                  {isExpanded && detail && (
                    <div className="baseline-details">
                      <h4>操作序列</h4>
                      <div className="actions-preview">
                        {detail.actions.map((action, idx) => (
                          <div key={idx} className="action-preview">
                            <span className="action-index">{idx + 1}.</span>
                            <span className="action-type">{getActionTypeLabel(action.type)}</span>
                            {action.type === 'set_value' && (
                              <span className="action-detail">
                                {action.cell} = {typeof action.value === 'object' 
                                  ? (action.value.random ? `随机[${action.value.min}-${action.value.max}]` 
                                    : action.value.sequence ? `序列[${action.value.sequence.join(',')}]` 
                                    : JSON.stringify(action.value))
                                  : action.value}
                              </span>
                            )}
                            {action.type === 'snapshot' && (
                              <span className="action-detail">标签: {action.label}</span>
                            )}
                            {action.type === 'check_baseline' && (
                              <span className="action-detail">基线ID: {action.baselineId}</span>
                            )}
                            {action.type === 'run_sandbox' && (
                              <span className="action-detail">{action.instructions?.length || 0} 条指令</span>
                            )}
                          </div>
                        ))}
                      </div>

                      {history && history.length > 0 && (
                        <>
                          <h4>执行历史 (最近30次)</h4>
                          <div className="history-list">
                            {history.map((record, idx) => (
                              <div key={idx} className="history-item">
                                <div className="history-header">
                                  <span>{formatDate(record.timestamp)}</span>
                                  {getStatusBadge(record.status)}
                                </div>
                                <div className="history-actions">
                                  {record.actionResults.map((ar, aidx) => (
                                    <div key={aidx} className={`history-action ${ar.status}`}>
                                      <span>{getActionTypeLabel(ar.type)}</span>
                                      <span className="action-result">
                                        {ar.status === 'success' ? '✓' : '✗'}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
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
