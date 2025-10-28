'use strict';
(async function(){
  const rows = document.getElementById('rows');
  const meta = document.getElementById('meta');
  const err = document.getElementById('error');

  async function read(){
    const local = await chrome.storage.local.get(['cpi-resender:data','cpi-resender:error']);
    if (local['cpi-resender:error']) {
      err.textContent = local['cpi-resender:error'];
    } else {
      err.textContent = '';
    }
    const data = local['cpi-resender:data'];
    if (!data) {
      meta.textContent = 'Waiting for data from CPI…';
      return;
    }
    meta.textContent = `${data.tenant} • ${data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : ''}`;
    rows.innerHTML = '';
    const artifacts = data.artifacts || [];
    const counts = data.counts || {};
    artifacts.forEach(a=>{
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = a.name || a.symbolicName;
      const tdComp = document.createElement('td');
      tdComp.className = 'right status ok';
      tdComp.textContent = (counts[a.symbolicName]?.completed ?? 0);
      const tdFail = document.createElement('td');
      tdFail.className = 'right status error';
      tdFail.textContent = (counts[a.symbolicName]?.failed ?? 0);
      tr.appendChild(tdName); tr.appendChild(tdComp); tr.appendChild(tdFail);
      rows.appendChild(tr);
    });
  }

  await read();
  setInterval(read, 2000);
})();
