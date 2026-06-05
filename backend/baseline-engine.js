const MAX_BASELINES = 30;
const DEFAULT_TOLERANCE = 0.0001;

class BaselineEngine {
  constructor() {
    this.baselines = [];
    this.nextId = 1;
  }

  captureSnapshot(computeGraph) {
    const snapshot = [];
    for (const [name, cell] of computeGraph.cells.entries()) {
      snapshot.push({
        name,
        type: cell.type,
        rawValue: cell.rawValue,
        value: cell.value ? { ...cell.value } : null
      });
    }
    return snapshot;
  }

  createBaseline(computeGraph, name, description = '') {
    if (!name || typeof name !== 'string' || name.trim() === '') {
      throw new Error('基线名称不能为空');
    }

    const snapshot = this.captureSnapshot(computeGraph);
    const baseline = {
      id: this.nextId++,
      name: name.trim(),
      description: description || '',
      createdAt: Date.now(),
      snapshot
    };

    this.baselines.unshift(baseline);

    if (this.baselines.length > MAX_BASELINES) {
      this.baselines.pop();
    }

    return baseline;
  }

  getBaselines() {
    return this.baselines.map(b => ({
      id: b.id,
      name: b.name,
      description: b.description,
      createdAt: b.createdAt,
      cellCount: b.snapshot.length
    }));
  }

  getBaseline(id) {
    const baseline = this.baselines.find(b => b.id === Number(id));
    if (!baseline) return null;
    return baseline;
  }

  deleteBaseline(id) {
    const index = this.baselines.findIndex(b => b.id === Number(id));
    if (index === -1) return false;
    this.baselines.splice(index, 1);
    return true;
  }

  compareValues(baselineValue, currentValue, tolerance = DEFAULT_TOLERANCE) {
    if (!baselineValue && !currentValue) {
      return { same: true, diff: null };
    }
    if (!baselineValue || !currentValue) {
      return { same: false, diff: 'changed' };
    }

    if (baselineValue.type !== currentValue.type) {
      return { same: false, diff: 'type_changed' };
    }

    if (baselineValue.type === 'number') {
      const bVal = baselineValue.value;
      const cVal = currentValue.value;
      const absDiff = Math.abs(cVal - bVal);
      const relDiff = bVal === 0 ? (cVal === 0 ? 0 : absDiff) : absDiff / Math.abs(bVal);
      const withinTolerance = relDiff <= tolerance;

      return {
        same: withinTolerance,
        diff: {
          absolute: absDiff,
          relative: relDiff,
          relativePercent: relDiff * 100
        },
        withinTolerance
      };
    }

    if (baselineValue.type === 'string') {
      const same = baselineValue.value === currentValue.value;
      return {
        same,
        diff: same ? 'unchanged' : 'changed',
        withinTolerance: same
      };
    }

    return { same: false, diff: 'unknown_type' };
  }

  checkBaseline(baselineId, computeGraph, tolerance = DEFAULT_TOLERANCE) {
    const baseline = this.getBaseline(baselineId);
    if (!baseline) {
      throw new Error(`基线 ${baselineId} 不存在`);
    }

    const baselineMap = new Map(baseline.snapshot.map(c => [c.name, c]));
    const currentMap = new Map();
    for (const [name, cell] of computeGraph.cells.entries()) {
      currentMap.set(name, {
        name,
        type: cell.type,
        rawValue: cell.rawValue,
        value: cell.value ? { ...cell.value } : null
      });
    }

    const allNames = new Set([...baselineMap.keys(), ...currentMap.keys()]);
    const details = [];
    let unchanged = 0;
    let changed = 0;
    let added = 0;
    let removed = 0;

    for (const name of allNames) {
      const baselineCell = baselineMap.get(name);
      const currentCell = currentMap.get(name);

      if (!baselineCell) {
        added++;
        details.push({
          name,
          baselineValue: null,
          currentValue: currentCell.value,
          diff: 'added',
          withinTolerance: false,
          changeType: 'added'
        });
      } else if (!currentCell) {
        removed++;
        details.push({
          name,
          baselineValue: baselineCell.value,
          currentValue: null,
          diff: 'removed',
          withinTolerance: false,
          changeType: 'removed'
        });
      } else {
        const comparison = this.compareValues(baselineCell.value, currentCell.value, tolerance);
        if (comparison.same) {
          unchanged++;
        } else {
          changed++;
          details.push({
            name,
            baselineValue: baselineCell.value,
            currentValue: currentCell.value,
            diff: comparison.diff,
            withinTolerance: comparison.withinTolerance || false,
            changeType: 'modified'
          });
        }
      }
    }

    const failedChanges = details.filter(d => !d.withinTolerance && d.changeType !== 'added' && d.changeType !== 'removed');
    const passed = failedChanges.length === 0 && added === 0 && removed === 0;

    return {
      passed,
      summary: {
        total: allNames.size,
        unchanged,
        changed,
        added,
        removed
      },
      details
    };
  }

  checkAllBaselines(computeGraph, tolerance = DEFAULT_TOLERANCE) {
    const results = [];
    for (const baseline of this.baselines) {
      try {
        const checkResult = this.checkBaseline(baseline.id, computeGraph, tolerance);
        results.push({
          id: baseline.id,
          name: baseline.name,
          passed: checkResult.passed,
          summary: checkResult.summary
        });
      } catch (e) {
        results.push({
          id: baseline.id,
          name: baseline.name,
          passed: false,
          error: e.message
        });
      }
    }
    const passCount = results.filter(r => r.passed).length;
    const failCount = results.filter(r => !r.passed).length;
    return {
      results,
      passCount,
      failCount,
      total: results.length
    };
  }

  isCellChanged(cellName, baselineMap, currentMap) {
    const baselineCell = baselineMap.get(cellName);
    const currentCell = currentMap.get(cellName);

    if (!baselineCell || !currentCell) {
      return true;
    }

    const hasValueChange = JSON.stringify(baselineCell.value) !== JSON.stringify(currentCell.value);
    const hasFormulaChange = baselineCell.type === 'formula' &&
      currentCell.type === 'formula' &&
      baselineCell.rawValue !== currentCell.rawValue;
    const hasTypeChange = baselineCell.type !== currentCell.type;

    return hasValueChange || hasFormulaChange || hasTypeChange;
  }

  getBlameType(cellName, baselineMap, currentMap) {
    const baselineCell = baselineMap.get(cellName);
    const currentCell = currentMap.get(cellName);

    if (!baselineCell && currentCell) {
      return 'added';
    }
    if (baselineCell && !currentCell) {
      return 'removed';
    }

    const hasFormulaChange = baselineCell.type === 'formula' &&
      currentCell.type === 'formula' &&
      baselineCell.rawValue !== currentCell.rawValue;

    if (hasFormulaChange) {
      return 'formula_changed';
    }

    return 'value_changed';
  }

  findAllBlameSources(changedCellName, baselineMap, currentMap, computeGraph) {
    const blameSources = [];
    const visited = new Set();

    const findRootCauses = (cellName, path) => {
      const currentPath = [...path, cellName];

      if (visited.has(cellName)) {
        return;
      }
      visited.add(cellName);

      const baselineCell = baselineMap.get(cellName);
      const currentCell = currentMap.get(cellName);

      if (!baselineCell || !currentCell) {
        blameSources.push({
          cell: cellName,
          blameType: this.getBlameType(cellName, baselineMap, currentMap),
          path: currentPath
        });
        return;
      }

      const hasFormulaChange = baselineCell.type === 'formula' &&
        currentCell.type === 'formula' &&
        baselineCell.rawValue !== currentCell.rawValue;
      const hasTypeChange = baselineCell.type !== currentCell.type;

      if (currentCell.type === 'constant') {
        if (this.isCellChanged(cellName, baselineMap, currentMap)) {
          blameSources.push({
            cell: cellName,
            blameType: 'value_changed',
            path: currentPath
          });
        }
        return;
      }

      if (hasFormulaChange || hasTypeChange) {
        blameSources.push({
          cell: cellName,
          blameType: this.getBlameType(cellName, baselineMap, currentMap),
          path: currentPath
        });
        return;
      }

      const cell = computeGraph.cells.get(cellName);
      if (!cell || !cell.dependencies) {
        return;
      }

      const localDeps = cell.dependencies.filter(d => !d.includes('::'));
      if (localDeps.length === 0) {
        if (this.isCellChanged(cellName, baselineMap, currentMap)) {
          blameSources.push({
            cell: cellName,
            blameType: 'value_changed',
            path: currentPath
          });
        }
        return;
      }

      for (const dep of localDeps) {
        findRootCauses(dep, currentPath);
      }
    };

    const changedCell = computeGraph.cells.get(changedCellName);
    if (!changedCell) {
      return [{
        cell: changedCellName,
        blameType: 'removed',
        path: [changedCellName]
      }];
    }

    if (!baselineMap.has(changedCellName)) {
      return [{
        cell: changedCellName,
        blameType: 'added',
        path: [changedCellName]
      }];
    }

    const localDeps = changedCell.dependencies ?
      changedCell.dependencies.filter(d => !d.includes('::')) : [];

    if (localDeps.length === 0) {
      return [{
        cell: changedCellName,
        blameType: this.getBlameType(changedCellName, baselineMap, currentMap),
        path: [changedCellName]
      }];
    }

    for (const dep of localDeps) {
      findRootCauses(dep, [changedCellName]);
    }

    if (blameSources.length === 0) {
      return [{
        cell: changedCellName,
        blameType: this.getBlameType(changedCellName, baselineMap, currentMap),
        path: [changedCellName]
      }];
    }

    return blameSources;
  }

  blame(baselineId, computeGraph, tolerance = DEFAULT_TOLERANCE) {
    const baseline = this.getBaseline(baselineId);
    if (!baseline) {
      throw new Error(`基线 ${baselineId} 不存在`);
    }

    const checkResult = this.checkBaseline(baselineId, computeGraph, tolerance);
    const changedDetails = checkResult.details.filter(d =>
      d.changeType === 'modified' || d.changeType === 'added' || d.changeType === 'removed'
    );

    const baselineMap = new Map(baseline.snapshot.map(c => [c.name, c]));
    const currentMap = new Map();
    for (const [name, cell] of computeGraph.cells.entries()) {
      currentMap.set(name, {
        name,
        type: cell.type,
        rawValue: cell.rawValue,
        value: cell.value ? { ...cell.value } : null
      });
    }

    const blameResults = [];
    for (const detail of changedDetails) {
      const blames = this.findAllBlameSources(detail.name, baselineMap, currentMap, computeGraph);
      for (const blame of blames) {
        blameResults.push({
          cell: detail.name,
          blameSource: blame.cell,
          blameType: blame.blameType,
          path: [...blame.path].reverse()
        });
      }
    }

    return blameResults;
  }
}

module.exports = { BaselineEngine };
