const { parseExpression } = require('./expression-parser');

const MAX_TEMPLATES = 100;

class TemplateManager {
  constructor(adminKey) {
    this.adminKey = adminKey || 'admin-secret-key';
    this.templates = new Map();
    this.nextId = 1;
  }

  validateCellName(name) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`单元格名称 '${name}' 无效，必须以字母开头，由字母、数字和下划线组成`);
    }
  }

  validateTemplateName(name) {
    if (!name || typeof name !== 'string' || name.length === 0) {
      throw new Error('模板名称不能为空');
    }
    if (name.length > 128) {
      throw new Error('模板名称最长128个字符');
    }
  }

  validatePrefix(prefix) {
    if (prefix === undefined || prefix === null || prefix === '') {
      return '';
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(prefix)) {
      throw new Error(`前缀 '${prefix}' 无效，必须以字母开头，由字母、数字和下划线组成`);
    }
    return prefix;
  }

  validateClosure(computeGraph, cellNames) {
    const cellNameSet = new Set(cellNames);
    const errors = [];

    for (const name of cellNames) {
      const cell = computeGraph.cells.get(name);
      if (!cell) {
        errors.push(`单元格 '${name}' 不存在`);
        continue;
      }

      if (cell.type === 'formula') {
        const localDeps = cell.dependencies.filter(d => !d.includes('::'));
        const crossDeps = cell.dependencies.filter(d => d.includes('::'));

        for (const dep of localDeps) {
          if (!cellNameSet.has(dep)) {
            errors.push(`公式 '${name}' 引用的单元格 '${dep}' 不在模板内，依赖不闭合`);
          }
        }

        for (const dep of crossDeps) {
          errors.push(`公式 '${name}' 包含跨命名空间引用 '${dep}'，不允许打包到模板中`);
        }
      }
    }

    return errors;
  }

  extractParameters(cells) {
    return cells
      .filter(cell => cell.type === 'constant')
      .map(cell => ({
        name: cell.name,
        defaultValue: cell.rawValue,
        valueType: typeof cell.rawValue
      }));
  }

  createTemplate({ namespace, name, description, cellNames, computeGraph }) {
    this.validateTemplateName(name);

    if (this.templates.size >= MAX_TEMPLATES) {
      throw new Error(`模板市场最多支持 ${MAX_TEMPLATES} 个模板`);
    }

    if (!Array.isArray(cellNames) || cellNames.length === 0) {
      throw new Error('必须指定要打包的单元格列表');
    }

    const closureErrors = this.validateClosure(computeGraph, cellNames);
    if (closureErrors.length > 0) {
      throw new Error(`依赖不闭合: ${closureErrors.join('; ')}`);
    }

    const cells = [];
    for (const name of cellNames) {
      const cell = computeGraph.cells.get(name);
      cells.push({
        name: cell.name,
        type: cell.type,
        rawValue: cell.rawValue
      });
    }

    const parameters = this.extractParameters(cells);

    let templateId = null;
    for (const [id, tpl] of this.templates.entries()) {
      if (tpl.name === name && tpl.authorNamespace === namespace) {
        templateId = id;
        break;
      }
    }

    if (templateId === null) {
      templateId = this.nextId++;
    }

    const template = {
      id: templateId,
      name,
      description: description || '',
      authorNamespace: namespace,
      createdAt: Date.now(),
      cells,
      parameters
    };

    this.templates.set(templateId, template);

    while (this.templates.size > MAX_TEMPLATES) {
      const oldestId = Math.min(...this.templates.keys());
      this.templates.delete(oldestId);
    }

    return template;
  }

  getTemplate(id) {
    return this.templates.get(id) || null;
  }

  listTemplates() {
    return Array.from(this.templates.values()).map(tpl => ({
      id: tpl.id,
      name: tpl.name,
      description: tpl.description,
      author: tpl.authorNamespace,
      paramCount: tpl.parameters.length,
      cellCount: tpl.cells.length,
      createdAt: tpl.createdAt
    }));
  }

  deleteTemplate(id, namespace, isAdmin = false) {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`模板 ${id} 不存在`);
    }

    if (!isAdmin && template.authorNamespace !== namespace) {
      throw new Error('只有模板作者或全局管理员可以删除此模板');
    }

    this.templates.delete(id);
    return { success: true, deleted: id };
  }

  applyPrefixToFormula(rawValue, prefix, cellNameSet) {
    try {
      const { ast, dependencies } = parseExpression(rawValue);
      let result = rawValue;

      const sortedDeps = [...dependencies].sort((a, b) => b.length - a.length);

      for (const dep of sortedDeps) {
        if (!dep.includes('::') && cellNameSet.has(dep)) {
          const prefixedDep = prefix + dep;
          result = result.split(dep).join(prefixedDep);
        }
      }

      return result;
    } catch (e) {
      return rawValue;
    }
  }

  installTemplate(templateId, { targetNamespace, computeGraph, parameterOverrides = {}, prefix = '' }) {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`模板 ${templateId} 不存在`);
    }

    const validatedPrefix = this.validatePrefix(prefix);

    const cellsToCreate = [];
    const conflicts = [];
    const originalNameMap = new Map();
    const originalNameSet = new Set();

    for (const cell of template.cells) {
      const prefixedName = validatedPrefix + cell.name;
      originalNameMap.set(cell.name, prefixedName);
      originalNameSet.add(cell.name);

      if (computeGraph.cells.has(prefixedName)) {
        conflicts.push(prefixedName);
      }
    }

    if (conflicts.length > 0) {
      throw new Error(`目标命名空间中已存在同名单元格: ${conflicts.join(', ')}`);
    }

    for (const cell of template.cells) {
      const prefixedName = originalNameMap.get(cell.name);
      let rawValue = cell.rawValue;

      if (cell.type === 'constant' && parameterOverrides && parameterOverrides.hasOwnProperty(cell.name)) {
        rawValue = parameterOverrides[cell.name];
      }

      if (cell.type === 'formula') {
        rawValue = this.applyPrefixToFormula(cell.rawValue, validatedPrefix, originalNameSet);
      }

      cellsToCreate.push({
        name: prefixedName,
        type: cell.type,
        value: rawValue
      });
    }

    return {
      cells: cellsToCreate,
      originalNames: Array.from(originalNameMap.entries()).map(([orig, prefixed]) => ({
        original: orig,
        installed: prefixed
      }))
    };
  }

  getDemoTemplateDefinition() {
    return {
      namespace: 'demo',
      name: '价格计算模板',
      description: '一个完整的价格计算场景，包含单价、数量、折扣、税费等计算逻辑。参数: unit_price(单价), quantity(数量), discount_rate(折扣率)',
      cellNames: ['unit_price', 'quantity', 'discount_rate', 'subtotal', 'discount', 'total', 'tax', 'final', 'status']
    };
  }
}

module.exports = { TemplateManager };
