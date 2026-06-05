import React, { useState, useEffect } from 'react';
import {
  fetchRules,
  createRule,
  deleteRule,
  enableRule,
  disableRule,
  fetchRuleHistory
} from './api.js';

export default function RulePanel({ isOpen, onClose, cells, showNotification }) {
  const [rules, setRules] = useState([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedRule, setSelectedRule] = useState(null);
  const [history, setHistory] = useState([]);
  const [formData, setFormData] = useState({
    targetCell: '',
    condition: '',
    actionType: 'alert',
    message: '',
    instructions: '[]',
    cooldown: 60
  });

  const loadRules = async () => {
    try {
      const data = await fetchRules();
      setRules(data);
    } catch (e) {
      showNotification('加载规则失败: ' + e.message, 'error');
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadRules();
    }
  }, [isOpen]);

  const handleViewHistory = async (ruleId) => {
    try {
      const hist = await fetchRuleHistory(ruleId);
      setHistory(hist);
      setSelectedRule(ruleId);
    } catch (e) {
      showNotification('加载历史失败: ' + e.message, 'error');
    }
  };

  const handleCreateRule = async () => {
    try {
      let actionParams;
      if (formData.actionType === 'alert') {
        actionParams = { message: formData.message };
      } else {
        actionParams = { instructions: JSON.parse(formData.instructions) };
      }

      await createRule({
        targetCell: formData.targetCell,
        condition: formData.condition,
        actionType: formData.actionType,
        actionParams,
        cooldown: Number(formData.cooldown)
      });

      setShowCreateForm(false);
      setFormData({
        targetCell: '',
        condition: '',
        actionType: 'alert',
        message: '',
        instructions: '[]',
        cooldown: 60
      });
      loadRules();
      showNotification('规则创建成功', 'success');
    } catch (e) {
      showNotification('创建规则失败: ' + e.message, 'error');
    }
  };

  const handleDeleteRule = async (id) => {
    if (!window.confirm('确定要删除这条规则吗？')) return;
    try {
      await deleteRule(id);
      loadRules();
      if (selectedRule === id) {
        setSelectedRule(null);
        setHistory([]);
      }
      showNotification('规则已删除', 'success');
    } catch (e) {
      showNotification('删除规则失败: ' + e.message, 'error');
    }
  };

  const handleToggleRule = async (id, enabled) => {
    try {
      if (enabled) {
        await disableRule(id);
      } else {
        await enableRule(id);
      }
      loadRules();
    } catch (e) {
      showNotification('操作失败: ' + e.message, 'error');
    }
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleString();
  };

  if (!isOpen) return null;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer rule-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>⚡ 规则管理</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>

        <div className="drawer-content">
          <div className="rule-actions">
            <button 
              className="btn-primary" 
              onClick={() => setShowCreateForm(true)}
              style={{ width: '100%' }}
            >
              + 新建规则
            </button>
          </div>

          {showCreateForm && (
            <div className="create-rule-form">
              <h3>新建规则</h3>
              
              <div className="form-group">
                <label>目标单元格</label>
                <select
                  value={formData.targetCell}
                  onChange={(e) => setFormData({ ...formData, targetCell: e.target.value })}
                >
                  <option value="">选择单元格</option>
                  {cells.map(c => (
                    <option key={c.name} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>条件表达式 (返回0或1)</label>
                <input
                  type="text"
                  placeholder="例如: total > 1000 或 discount_rate == 0"
                  value={formData.condition}
                  onChange={(e) => setFormData({ ...formData, condition: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>动作类型</label>
                <select
                  value={formData.actionType}
                  onChange={(e) => setFormData({ ...formData, actionType: e.target.value })}
                >
                  <option value="alert">推送告警 (alert)</option>
                  <option value="sandbox">执行沙箱脚本 (sandbox)</option>
                </select>
              </div>

              {formData.actionType === 'alert' ? (
                <div className="form-group">
                  <label>消息模板 (支持 {{name}} 和 {{value}} 占位符)</label>
                  <input
                    type="text"
                    placeholder="例如: 警告: {{name}} 超过阈值，当前值: {{value}}"
                    value={formData.message}
                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                  />
                </div>
              ) : (
                <div className="form-group">
                  <label>沙箱指令 (JSON数组)</label>
                  <textarea
                    rows={4}
                    placeholder='[{"op":"update","name":"discount_rate","type":"constant","value":0}]'
                    value={formData.instructions}
                    onChange={(e) => setFormData({ ...formData, instructions: e.target.value })}
                  />
                </div>
              )}

              <div className="form-group">
                <label>冷却时间 (秒，默认60秒)</label>
                <input
                  type="number"
                  min="0"
                  value={formData.cooldown}
                  onChange={(e) => setFormData({ ...formData, cooldown: e.target.value })}
                />
              </div>

              <div className="form-actions">
                <button className="btn-secondary" onClick={() => setShowCreateForm(false)}>
                  取消
                </button>
                <button className="btn-primary" onClick={handleCreateRule}>
                  创建
                </button>
              </div>
            </div>
          )}

          <div className="rule-list">
            <h3>规则列表 ({rules.length})</h3>
            {rules.length === 0 ? (
              <div className="empty-state">暂无规则</div>
            ) : (
              rules.map(rule => (
                <div key={rule.id} className={`rule-item ${rule.enabled ? '' : 'disabled'}`}>
                  <div className="rule-header">
                    <span className="rule-target">🎯 {rule.targetCell}</span>
                    <div className="rule-status">
                      <span className={`status-badge ${rule.enabled ? 'enabled' : 'disabled'}`}>
                        {rule.enabled ? '已启用' : '已禁用'}
                      </span>
                    </div>
                  </div>
                  <div className="rule-condition">
                    <strong>条件:</strong> {rule.condition}
                  </div>
                  <div className="rule-action">
                    <strong>动作:</strong> {rule.actionType === 'alert' 
                      ? `推送: ${rule.actionParams?.message}` 
                      : `沙箱: ${rule.actionParams?.instructions?.length || 0} 条指令`}
                  </div>
                  <div className="rule-meta">
                    <span>触发: {rule.triggerCount} 次</span>
                    <span>最近: {formatTime(rule.lastTriggeredAt)}</span>
                  </div>
                  <div className="rule-controls">
                    <button 
                      className="btn-sm btn-secondary"
                      onClick={() => handleToggleRule(rule.id, rule.enabled)}
                    >
                      {rule.enabled ? '禁用' : '启用'}
                    </button>
                    <button 
                      className="btn-sm btn-secondary"
                      onClick={() => handleViewHistory(rule.id)}
                    >
                      历史
                    </button>
                    <button 
                      className="btn-sm btn-danger"
                      onClick={() => handleDeleteRule(rule.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {selectedRule && history.length > 0 && (
            <div className="rule-history">
              <h3>触发历史 (规则 #{selectedRule})</h3>
              <div className="history-list">
                {history.map((h, i) => (
                  <div key={i} className="history-item">
                    <div className="history-time">{formatTime(h.timestamp)}</div>
                    <div className="history-result">
                      <span className={`result-${h.actionResult.status}`}>
                        {h.actionResult.status}
                      </span>
                      {h.actionResult.message && (
                        <span className="history-message">{h.actionResult.message}</span>
                      )}
                      {h.actionResult.summary && (
                        <span className="history-summary">
                          {h.actionResult.summary.frameCount} 帧, {h.actionResult.summary.changed} 变更
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <button 
                className="btn-sm btn-secondary"
                onClick={() => { setSelectedRule(null); setHistory([]); }}
                style={{ marginTop: '8px' }}
              >
                关闭历史
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
