const API_BASE = '/api';

export async function fetchCells() {
  const res = await fetch(`${API_BASE}/cells`);
  const data = await res.json();
  return data.cells || [];
}

export async function createCell(name, type, value) {
  const res = await fetch(`${API_BASE}/cells`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, value })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function updateCell(name, type, value) {
  const res = await fetch(`${API_BASE}/cells/${name}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, value })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function renameCell(oldName, newName) {
  const res = await fetch(`${API_BASE}/cells/${oldName}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ renameTo: newName })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function deleteCell(name) {
  const res = await fetch(`${API_BASE}/cells/${name}`, {
    method: 'DELETE'
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function batchOperation(cells) {
  const res = await fetch(`${API_BASE}/cells/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cells })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function exportGraph() {
  const res = await fetch(`${API_BASE}/cells/export`);
  return res.json();
}

export async function importGraph(data) {
  const res = await fetch(`${API_BASE}/cells/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result;
}

export async function createSnapshot(label = '') {
  const res = await fetch(`${API_BASE}/snapshots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label })
  });
  return res.json();
}

export async function fetchSnapshots() {
  const res = await fetch(`${API_BASE}/snapshots`);
  const data = await res.json();
  return data.snapshots || [];
}

export async function fetchSnapshot(id) {
  const res = await fetch(`${API_BASE}/snapshots/${id}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function deleteSnapshot(id) {
  const res = await fetch(`${API_BASE}/snapshots/${id}`, {
    method: 'DELETE'
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function restoreSnapshot(id) {
  const res = await fetch(`${API_BASE}/snapshots/${id}/restore`, {
    method: 'POST'
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function compareSnapshots(a, b) {
  const res = await fetch(`${API_BASE}/snapshots/diff?a=${a}&b=${b}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

export async function fetchTrace(name) {
  const res = await fetch(`${API_BASE}/cells/${name}/trace`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
