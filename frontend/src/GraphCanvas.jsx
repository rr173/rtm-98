import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ForceLayout } from './force-layout.js';

const NODE_WIDTH = 120;
const NODE_HEIGHT = 60;
const BORDER_RADIUS = 8;

function getHeatmapColor(avgMs, maxMs) {
  if (avgMs <= 0 || maxMs <= 0) return null;
  const ratio = Math.min(avgMs / maxMs, 1);
  const r = Math.round(255 * ratio);
  const g = Math.round(255 * (1 - ratio));
  return `rgb(${r}, ${g}, 0)`;
}

export default function GraphCanvas({
  cells,
  selectedCell,
  onSelectCell,
  onNodeDoubleClick,
  onBackgroundDoubleClick,
  onChange,
  flashingCells,
  diffCells = new Set(),
  heatmapEnabled = false,
  cellPerfData = new Map()
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const layoutRef = useRef(null);
  const animationRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ node: null, offsetX: 0, offsetY: 0, moved: false });
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const getCell = useCallback((name) => cells.find(c => c.name === name), [cells]);

  const drawArrow = useCallback((ctx, fromX, fromY, toX, toY) => {
    const headLength = 12;
    const angle = Math.atan2(toY - fromY, toX - fromX);

    const targetX = toX - Math.cos(angle) * (NODE_WIDTH / 2);
    const targetY = toY - Math.sin(angle) * (NODE_HEIGHT / 2);

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(targetX, targetY);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(targetX, targetY);
    ctx.lineTo(
      targetX - headLength * Math.cos(angle - Math.PI / 6),
      targetY - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.moveTo(targetX, targetY);
    ctx.lineTo(
      targetX - headLength * Math.cos(angle + Math.PI / 6),
      targetY - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, []);

  const maxPerfMs = React.useMemo(() => {
    if (cellPerfData.size === 0) return 0;
    let max = 0;
    for (const perf of cellPerfData.values()) {
      max = Math.max(max, perf.avgMs || 0);
    }
    return max;
  }, [cellPerfData]);

  const drawNode = useCallback((ctx, node, cell) => {
    const { x, y } = node;
    const isSelected = selectedCell && selectedCell.name === node.name;
    const isFlashing = flashingCells.has(node.name);
    const isDiff = diffCells.has(node.name);
    const perfData = cellPerfData.get(node.name);

    let borderColor = '#3b82f6';
    if (cell && cell.type === 'formula') {
      borderColor = '#22c55e';
    }
    if (heatmapEnabled && perfData && !isSelected) {
      const heatColor = getHeatmapColor(perfData.avgMs, maxPerfMs);
      if (heatColor) {
        borderColor = heatColor;
      }
    }
    if (isSelected) {
      borderColor = '#f59e0b';
    }
    if (isDiff && !isSelected) {
      borderColor = '#f97316';
    }

    if (isFlashing) {
      const time = flashingCells.get(node.name);
      const elapsed = Date.now() - time;
      const alpha = Math.max(0, 1 - elapsed / 500);
      ctx.shadowColor = `rgba(234, 179, 8, ${alpha})`;
      ctx.shadowBlur = 20;
    } else if (isDiff) {
      ctx.shadowColor = 'rgba(249, 115, 22, 0.5)';
      ctx.shadowBlur = 15;
    }

    ctx.fillStyle = isFlashing
      ? `rgba(250, 204, 21, ${Math.max(0.1, 1 - (Date.now() - flashingCells.get(node.name)) / 500)})`
      : isDiff
      ? 'rgba(255, 247, 237, 1)'
      : '#ffffff';

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = isSelected || isDiff ? 3 : 2;

    ctx.beginPath();
    ctx.roundRect(
      x - NODE_WIDTH / 2,
      y - NODE_HEIGHT / 2,
      NODE_WIDTH,
      NODE_HEIGHT,
      BORDER_RADIUS
    );
    ctx.fill();
    ctx.stroke();

    ctx.shadowBlur = 0;

    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 12px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.name, x, y - 10);

    if (cell) {
      let displayValue = '';
      if (cell.error) {
        displayValue = '#ERROR';
        ctx.fillStyle = '#ef4444';
      } else if (cell.value) {
        displayValue = typeof cell.value.value === 'number'
          ? cell.value.value.toFixed(2)
          : String(cell.value.value);
        ctx.fillStyle = '#64748b';
      } else {
        displayValue = '...';
        ctx.fillStyle = '#94a3b8';
      }
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.fillText(displayValue.substring(0, 15), x, y + 12);
    }
  }, [selectedCell, flashingCells, diffCells, heatmapEnabled, cellPerfData, maxPerfMs]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    canvas.width = dimensions.width * dpr;
    canvas.height = dimensions.height * dpr;
    canvas.style.width = `${dimensions.width}px`;
    canvas.style.height = `${dimensions.height}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, dimensions.width, dimensions.height);

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < dimensions.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, dimensions.height);
      ctx.stroke();
    }
    for (let y = 0; y < dimensions.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(dimensions.width, y);
      ctx.stroke();
    }

    for (const edge of layout.getEdges()) {
      const source = layout.getNode(edge.source);
      const target = layout.getNode(edge.target);
      if (source && target) {
        drawArrow(
          ctx,
          source.x,
          source.y,
          target.x,
          target.y
        );
      }
    }

    for (const node of layout.getNodes()) {
      const cell = getCell(node.name);
      drawNode(ctx, node, cell);
    }
  }, [dimensions, drawArrow, drawNode, getCell]);

  const animate = useCallback(() => {
    const layout = layoutRef.current;
    if (!layout) return;

    const running = layout.step();
    render();

    if (running || flashingCells.size > 0 || diffCells.size > 0 || heatmapEnabled) {
      animationRef.current = requestAnimationFrame(animate);
    } else {
      animationRef.current = null;
    }
  }, [render, flashingCells.size, diffCells.size, heatmapEnabled]);

  useEffect(() => {
    if (!layoutRef.current) {
      layoutRef.current = new ForceLayout(dimensions.width, dimensions.height);
    } else {
      layoutRef.current.setSize(dimensions.width, dimensions.height);
    }
    layoutRef.current.updateFromCells(cells);

    if (!animationRef.current) {
      animationRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [cells, dimensions, animate]);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight
        });
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (layoutRef.current && cells.length > 0) {
      layoutRef.current.updateFromCells(cells);
      if (!animationRef.current) {
        animationRef.current = requestAnimationFrame(animate);
      }
    }
  }, [cells, animate]);

  const getCanvasCoords = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  const handleMouseDown = (e) => {
    const { x, y } = getCanvasCoords(e);
    const node = layoutRef.current?.findNodeAt(x, y);

    if (node) {
      dragRef.current = {
        node,
        offsetX: x - node.x,
        offsetY: y - node.y,
        moved: false
      };
      setIsDragging(true);
      onSelectCell(getCell(node.name));
    }
  };

  const handleMouseMove = (e) => {
    if (!isDragging || !dragRef.current.node) return;

    const { x, y } = getCanvasCoords(e);
    const newX = x - dragRef.current.offsetX;
    const newY = y - dragRef.current.offsetY;

    dragRef.current.node.x = newX;
    dragRef.current.node.y = newY;
    dragRef.current.moved = true;

    render();
  };

  const handleMouseUp = () => {
    if (dragRef.current.node && dragRef.current.moved) {
      layoutRef.current.fixNode(
        dragRef.current.node.name,
        dragRef.current.node.x,
        dragRef.current.node.y
      );
    }
    dragRef.current = { node: null, offsetX: 0, offsetY: 0, moved: false };
    setIsDragging(false);
  };

  const handleClick = (e) => {
    if (dragRef.current.moved) return;

    const { x, y } = getCanvasCoords(e);
    const node = layoutRef.current?.findNodeAt(x, y);

    if (node) {
      onSelectCell(getCell(node.name));
    } else {
      onSelectCell(null);
    }
  };

  const handleDoubleClick = (e) => {
    const { x, y } = getCanvasCoords(e);
    const node = layoutRef.current?.findNodeAt(x, y);

    if (node) {
      onNodeDoubleClick(getCell(node.name));
    } else {
      onBackgroundDoubleClick(x, y);
    }
  };

  return (
    <div ref={containerRef} className="canvas-container">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        style={{ cursor: isDragging ? 'grabbing' : 'default' }}
      />
    </div>
  );
}
