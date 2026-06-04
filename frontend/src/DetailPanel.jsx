import React, { useState, useEffect, useCallback } from 'react';
import { fetchTrace } from './api.js';

function FormulaWithErrorUnderline({ rawValue, structuredError }) {
  if (!structuredError || !structuredError.position) {
    return <code className="formula-display">{rawValue}</code>;
  }

  const { start, end } = structuredError.position;
  const before = rawValue.slice(0, start);
  const errorPart = rawValue.slice(start, end);
  const after = rawValue.slice(end);

  return (
    <code className="formula-display formula-with-error">
      {before}
      <span
        className="error-underline"
        title={structuredError.message}
      >
        {errorPart}
      </span>
      {after}
    </code>
  );
}

function TraceTable({ steps }) {
  if (!steps || steps.length === 0) return null;

  const formatResolved = (val) => {
    if (typeof val === 'number') {
      return Number.isInteger(val) ? val.toString() : val.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    }
    return `"${val}"`;
  };

  const typeLabel = {
    literal: '字面量',
    reference: '引用',
    unary_op: '一元运算',
    binary_op: '二元运算',
    function: '函数'
  };

  return (
    <table className="trace-table">
      <thead>
        <tr>
          <th>步骤</th>
          <th>表达式</th>
          <th>求值结果</th>
          <th>类型</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.step}>
            <td className="trace-step-num">{s.step}</td>
            <td className="trace-expr"><code>{s.expression}</code></td>
            <td className="trace-resolved"><code>{formatResolved(s.resolved)}</code></td>
            <td className="trace-type">{typeLabel[s.type] || s.type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function DetailPanel({ cell, onSelectCell }) {
  const [debugOpen, setDebugOpen] = useState(false);
  const [traceData, setTraceData] = useState(null);
  const [traceLoading, setTraceLoading] = useState(false);

  useEffect(() => {
    setDebugOpen(false);
    setTraceData(null);
  }, [cell?.name]);

  const handleToggleDebug = useCallback(async () => {
    if (!cell) return;

    if (!debugOpen) {
      setDebugOpen(true);
      setTraceLoading(true);
      try {
        const data = await fetchTrace(cell.name);
        setTraceData(data);
      } catch (e) {
        setTraceData({ steps: [], error: { message: e.message, position: null, context: null } });
      } finally {
        setTraceLoading(false);
      }
    } else {
      setDebugOpen(false);
    }
  }, [cell, debugOpen]);

  if (!cell) {
    return (
      <div className="detail-panel">
        <div className="detail-empty">
          <p>选择一个节点查看详情</p>
          <p className="hint">双击背景新建节点</p>
          <p className="hint">拖拽节点调整位置</p>
        </div>
      </div>
    );
  }

  const formatValue = (val) => {
    if (!val) return '-';
    if (typeof val.value === 'number') {
      return val.value.toFixed(4);
    }
    return `"${val.value}"`;
  };

  const structuredError = cell.structuredError;

  return (
    <div className="detail-panel">
      <div className="detail-header">
        <h3>{cell.name}</h3>
        <span className={`cell-type-badge ${cell.type}`}>
          {cell.type === 'constant' ? '常量' : '表达式'}
        </span>
      </div>

      {cell.error && (
        <div className="detail-error">
          <strong>错误:</strong> {cell.error}
          {structuredError && structuredError.context && (
            <div className="error-context">上下文: …{structuredError.context}…</div>
          )}
        </div>
      )}

      <div className="detail-section">
        <h4>表达式</h4>
        {cell.type === 'formula' && structuredError && structuredError.position ? (
          <FormulaWithErrorUnderline rawValue={cell.rawValue} structuredError={structuredError} />
        ) : (
          <code className="formula-display">
            {cell.type === 'constant'
              ? (typeof cell.rawValue === 'string' ? `"${cell.rawValue}"` : cell.rawValue)
              : cell.rawValue}
          </code>
        )}
      </div>

      <div className="detail-section">
        <h4>计算结果</h4>
        <div className="result-value">{formatValue(cell.value)}</div>
        <div className="result-type">
          类型: {cell.value ? cell.value.type : '-'}
        </div>
      </div>

      <div className="detail-section">
        <button className="debug-toggle-btn" onClick={handleToggleDebug}>
          <span className={`debug-toggle-arrow ${debugOpen ? 'open' : ''}`}>▶</span>
          调试
        </button>
        {debugOpen && (
          <div className="debug-content">
            {traceLoading ? (
              <div className="trace-loading">加载中...</div>
            ) : traceData ? (
              <>
                {traceData.error && (
                  <div className="trace-error">
                    <strong>求值错误:</strong> {traceData.error.message}
                    {traceData.error.context && (
                      <div className="error-context">上下文: …{traceData.error.context}…</div>
                    )}
                  </div>
                )}
                <TraceTable steps={traceData.steps} />
              </>
            ) : null}
          </div>
        )}
      </div>

      <div className="detail-section">
        <h4>上游依赖</h4>
        {cell.dependencies && cell.dependencies.length > 0 ? (
          <div className="dependency-list">
            {cell.dependencies.map(dep => (
              <button
                key={dep}
                className="dependency-link"
                onClick={() => onSelectCell(dep)}
              >
                {dep}
              </button>
            ))}
          </div>
        ) : (
          <div className="no-deps">无上游依赖</div>
        )}
      </div>

      <div className="detail-section">
        <h4>下游引用</h4>
        {cell.downstream && cell.downstream.length > 0 ? (
          <div className="dependency-list">
            {cell.downstream.map(dep => (
              <button
                key={dep}
                className="dependency-link"
                onClick={() => onSelectCell(dep)}
              >
                {dep}
              </button>
            ))}
          </div>
        ) : (
          <div className="no-deps">无下游引用</div>
        )}
      </div>

      <div className="detail-section">
        <h4>计算耗时</h4>
        <div className="compute-time">
          {cell.computeTimeMs !== undefined ? `${cell.computeTimeMs} ms` : '-'}
        </div>
      </div>
    </div>
  );
}
