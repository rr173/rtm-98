const MAX_SNAPSHOTS = 20;

class SnapshotManager {
  constructor() {
    this.snapshots = [];
    this.nextId = 1;
  }

  deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (obj instanceof Map) {
      const map = new Map();
      for (const [key, value] of obj.entries()) {
        map.set(key, this.deepClone(value));
      }
      return map;
    }
    if (obj instanceof Array) {
      return obj.map(item => this.deepClone(item));
    }
    const cloned = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        cloned[key] = this.deepClone(obj[key]);
      }
    }
    return cloned;
  }

  createSnapshot(computeGraph, label = '') {
    const cellsData = {};
    for (const [name, cell] of computeGraph.cells.entries()) {
      cellsData[name] = {
        type: cell.type,
        rawValue: cell.rawValue,
        value: cell.value ? { ...cell.value } : null,
        error: cell.error
      };
    }

    const snapshot = {
      id: this.nextId++,
      label: label || `Snapshot #${this.nextId - 1}`,
      timestamp: Date.now(),
      cellCount: Object.keys(cellsData).length,
      cells: this.deepClone(cellsData)
    };

    this.snapshots.push(snapshot);

    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.shift();
    }

    return {
      id: snapshot.id,
      label: snapshot.label,
      timestamp: snapshot.timestamp,
      cellCount: snapshot.cellCount
    };
  }

  getSnapshots() {
    return this.snapshots.map(s => ({
      id: s.id,
      label: s.label,
      timestamp: s.timestamp,
      cellCount: s.cellCount
    }));
  }

  getSnapshot(id) {
    const snapshot = this.snapshots.find(s => s.id === parseInt(id));
    if (!snapshot) {
      return null;
    }
    return this.deepClone(snapshot);
  }

  deleteSnapshot(id) {
    const index = this.snapshots.findIndex(s => s.id === parseInt(id));
    if (index === -1) {
      return false;
    }
    this.snapshots.splice(index, 1);
    return true;
  }

  compareSnapshots(snapshotA, snapshotB) {
    const cellsA = snapshotA.cells;
    const cellsB = snapshotB.cells;

    const added = [];
    const deleted = [];
    const modified = [];

    const allNames = new Set([...Object.keys(cellsA), ...Object.keys(cellsB)]);

    for (const name of allNames) {
      const inA = name in cellsA;
      const inB = name in cellsB;

      if (inA && !inB) {
        deleted.push(name);
      } else if (!inA && inB) {
        added.push(name);
      } else {
        const cellA = cellsA[name];
        const cellB = cellsB[name];

        const valueA = cellA.value;
        const valueB = cellB.value;

        const valueChanged = 
          (valueA === null && valueB !== null) ||
          (valueA !== null && valueB === null) ||
          (valueA && valueB && (valueA.value !== valueB.value || valueA.type !== valueB.type));

        if (valueChanged || cellA.type !== cellB.type || cellA.rawValue !== cellB.rawValue) {
          modified.push({
            name,
            oldValue: valueA ? valueA.value : null,
            newValue: valueB ? valueB.value : null,
            oldType: valueA ? valueA.type : null,
            newType: valueB ? valueB.type : null
          });
        }
      }
    }

    return {
      added,
      deleted,
      modified
    };
  }
}

module.exports = { SnapshotManager };
