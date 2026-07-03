function initQueueLog(socket) {
  const listEl = document.getElementById('queueLogList');
  const clientInput = document.getElementById('clientLabel');

  let clientId = sessionStorage.getItem('clientId');
  if (!clientId) {
    clientId = `User-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    sessionStorage.setItem('clientId', clientId);
  }
  clientInput.value = clientId;
  clientInput.addEventListener('change', () => {
    sessionStorage.setItem('clientId', clientInput.value.trim() || clientId);
  });

  window.getClientLabel = () => clientInput.value.trim() || clientId;

  function formatTime(iso) {
    return new Date(iso).toLocaleTimeString();
  }

  function prependEntry(entry) {
    const li = document.createElement('li');
    li.className = `queue-entry${entry.type === 'claimed' ? ' claimed' : ''}`;

    const payload = entry.type === 'claimed'
      ? { taskId: entry.taskId, workerId: entry.workerId, claimedAt: entry.claimedAt }
      : {
          taskId: entry.taskId,
          filename: entry.filename,
          originalName: entry.originalName,
          backgroundColor: entry.backgroundColor,
          clientLabel: entry.clientLabel,
          queue: entry.queue,
        };

    li.innerHTML = `
      <div class="entry-head">
        <span class="entry-badge">${entry.type === 'claimed' ? 'worker picked' : '→ queue'}</span>
        <time>${formatTime(entry.queuedAt || entry.claimedAt)}</time>
      </div>
      <pre>${JSON.stringify(payload, null, 2)}</pre>`;

    listEl.prepend(li);
    while (listEl.children.length > 50) {
      listEl.lastChild.remove();
    }
  }

  socket.on('task:queued', (payload) => prependEntry({ type: 'queued', ...payload }));
  socket.on('task:claimed', (payload) => prependEntry({ type: 'claimed', ...payload }));

  fetch('/api/queue-log')
    .then((r) => r.json())
    .then((entries) => entries.slice().reverse().forEach((e) => prependEntry({ type: 'queued', ...e })))
    .catch(() => {});

  return window.getClientLabel;
}
