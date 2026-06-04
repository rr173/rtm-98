export class ForceLayout {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.nodes = new Map();
    this.edges = [];
    this.alpha = 1;
    this.alphaDecay = 0.02;
    this.alphaMin = 0.001;
    this.repulsionStrength = 5000;
    this.attractionStrength = 0.01;
    this.centerStrength = 0.01;
    this.drag = 0.6;
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
  }

  addNode(name, data = {}) {
    if (!this.nodes.has(name)) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 50 + Math.random() * 100;
      this.nodes.set(name, {
        name,
        x: this.width / 2 + Math.cos(angle) * radius,
        y: this.height / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        fixed: false,
        ...data
      });
    }
    return this.nodes.get(name);
  }

  removeNode(name) {
    this.nodes.delete(name);
    this.edges = this.edges.filter(e => e.source !== name && e.target !== name);
  }

  addEdge(source, target) {
    if (!this.edges.find(e => e.source === source && e.target === target)) {
      this.edges.push({ source, target });
    }
  }

  fixNode(name, x, y) {
    const node = this.nodes.get(name);
    if (node) {
      node.fixed = true;
      node.x = x;
      node.y = y;
      node.vx = 0;
      node.vy = 0;
    }
  }

  releaseNode(name) {
    const node = this.nodes.get(name);
    if (node) {
      node.fixed = false;
    }
  }

  step() {
    if (this.alpha < this.alphaMin) return false;

    const nodes = Array.from(this.nodes.values());
    const nodeMap = this.nodes;

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) distSq = 1;
        const dist = Math.sqrt(distSq);
        const force = this.repulsionStrength / distSq;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        if (!a.fixed) {
          a.vx -= fx * this.alpha;
          a.vy -= fy * this.alpha;
        }
        if (!b.fixed) {
          b.vx += fx * this.alpha;
          b.vy += fy * this.alpha;
        }
      }
    }

    for (const edge of this.edges) {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) continue;

      let dx = target.x - source.x;
      let dy = target.y - source.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) distSq = 1;
      const dist = Math.sqrt(distSq);
      const targetDist = 150;
      const delta = dist - targetDist;
      const force = delta * this.attractionStrength;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (!source.fixed) {
        source.vx += fx * this.alpha;
        source.vy += fy * this.alpha;
      }
      if (!target.fixed) {
        target.vx -= fx * this.alpha;
        target.vy -= fy * this.alpha;
      }
    }

    const cx = this.width / 2;
    const cy = this.height / 2;
    for (const node of nodes) {
      if (!node.fixed) {
        node.vx += (cx - node.x) * this.centerStrength * this.alpha;
        node.vy += (cy - node.y) * this.centerStrength * this.alpha;
      }
    }

    for (const node of nodes) {
      if (!node.fixed) {
        node.vx *= this.drag;
        node.vy *= this.drag;
        node.x += node.vx;
        node.y += node.vy;

        const margin = 50;
        node.x = Math.max(margin, Math.min(this.width - margin, node.x));
        node.y = Math.max(margin, Math.min(this.height - margin, node.y));
      }
    }

    this.alpha *= (1 - this.alphaDecay);

    return true;
  }

  reheat() {
    this.alpha = 1;
  }

  getNode(name) {
    return this.nodes.get(name);
  }

  getNodes() {
    return Array.from(this.nodes.values());
  }

  getEdges() {
    return this.edges;
  }

  updateFromCells(cells) {
    const existingNames = new Set(this.nodes.keys());
    const newNames = new Set(cells.map(c => c.name));

    for (const name of existingNames) {
      if (!newNames.has(name)) {
        this.removeNode(name);
      }
    }

    for (const cell of cells) {
      this.addNode(cell.name, { type: cell.type });
    }

    this.edges = [];
    for (const cell of cells) {
      if (cell.dependencies) {
        for (const dep of cell.dependencies) {
          if (this.nodes.has(dep)) {
            this.addEdge(dep, cell.name);
          }
        }
      }
    }

    this.reheat();
  }

  findNodeAt(x, y, padding = 10) {
    const nodeWidth = 120;
    const nodeHeight = 60;

    for (const node of this.nodes.values()) {
      if (
        x >= node.x - nodeWidth / 2 - padding &&
        x <= node.x + nodeWidth / 2 + padding &&
        y >= node.y - nodeHeight / 2 - padding &&
        y <= node.y + nodeHeight / 2 + padding
      ) {
        return node;
      }
    }
    return null;
  }
}
