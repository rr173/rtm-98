export function createWebSocketConnection(onMessage, onOpen, onClose, onError) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/ws`;

  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket 连接已建立');
    if (onOpen) onOpen(ws);
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      if (onMessage) onMessage(message);
    } catch (e) {
      console.error('解析 WebSocket 消息失败:', e);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket 连接已关闭');
    if (onClose) onClose();
  };

  ws.onerror = (error) => {
    console.error('WebSocket 错误:', error);
    if (onError) onError(error);
  };

  return ws;
}
