import React, { useState, useEffect } from 'react';

export default function EditModal({
  cell,
  isNew,
  defaultX,
  defaultY,
  onSave,
  onDelete,
  onRename,
  onClose
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('constant');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (cell && !isNew) {
      setName(cell.name);
      setType(cell.type);
      if (cell.type === 'constant') {
        setValue(String(cell.rawValue));
      } else {
        setValue(cell.rawValue);
      }
    } else {
      setName('');
      setType('constant');
      setValue('');
    }
    setError('');
  }, [cell, isNew]);

  const parseValueInput = (type, input) => {
    if (type === 'constant') {
      const trimmed = input.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
      }
      const num = parseFloat(trimmed);
      if (!isNaN(num) && trimmed !== '') {
        return num;
      }
      return trimmed;
    }
    return input;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('请输入单元格名称');
      return;
    }

    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
      setError('名称必须以字母开头，由字母、数字和下划线组成');
      return;
    }

    try {
      const parsedValue = parseValueInput(type, value);
      onSave(name, type, parsedValue);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRename = () => {
    if (!name.trim()) {
      setError('请输入新的名称');
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
      setError('名称必须以字母开头，由字母、数字和下划线组成');
      return;
    }
    if (name === cell.name) {
      setError('新名称不能与原名称相同');
      return;
    }
    onRename(cell.name, name);
  };

  const handleDelete = () => {
    if (window.confirm(`确定要删除单元格 "${cell.name}" 吗？`)) {
      onDelete(cell.name);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isNew ? '新建单元格' : '编辑单元格'}</h2>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如: price"
              disabled={!isNew && type === 'formula' && cell && cell.dependencies && cell.dependencies.length > 0}
            />
          </div>

          <div className="form-group">
            <label>类型</label>
            <div className="radio-group">
              <label>
                <input
                  type="radio"
                  name="type"
                  value="constant"
                  checked={type === 'constant'}
                  onChange={(e) => setType(e.target.value)}
                />
                常量
              </label>
              <label>
                <input
                  type="radio"
                  name="type"
                  value="formula"
                  checked={type === 'formula'}
                  onChange={(e) => setType(e.target.value)}
                />
                表达式
              </label>
            </div>
          </div>

          <div className="form-group">
            <label>{type === 'constant' ? '值' : '表达式'}</label>
            {type === 'constant' ? (
              <input
                type="text"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder='数值或用双引号包裹的字符串，例如: 100 或 "hello"'
              />
            ) : (
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="例如: unit_price * quantity 或 IF(a > b, c, d)"
                rows={3}
              />
            )}
            {type === 'formula' && (
              <div className="form-hint">
                支持: + - * /, 比较 {'>'} {'<'} {'>='} {'<='} == !=, IF(), MIN(), MAX(), ABS(), ROUND(), CONCAT()
              </div>
            )}
          </div>

          {error && <div className="error-message">{error}</div>}

          <div className="modal-actions">
            {!isNew && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleRename}
                  disabled={type === 'formula' && cell && cell.downstream && cell.downstream.length > 0}
                  title={type === 'formula' && cell && cell.downstream && cell.downstream.length > 0 ? '被其他单元格引用时无法重命名' : ''}
                >
                  重命名
                </button>
                <button type="button" className="btn-danger" onClick={handleDelete}>
                  删除
                </button>
              </>
            )}
            <div className="spacer" />
            <button type="button" className="btn-secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn-primary">
              {isNew ? '创建' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
