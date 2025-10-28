async function sendToActiveTab(message){
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab');
  return new Promise((resolve)=>{
    chrome.tabs.sendMessage(tab.id, message, (resp)=>resolve(resp));
  });
}

function render(rows){
  const container = document.getElementById('rows');
  container.innerHTML = '';
  const fmt = n=> new Intl.NumberFormat().format(n);
  rows.sort((a,b)=> a.name.localeCompare(b.name));
  for (const r of rows){
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    const tdOk = document.createElement('td');
    const tdFail = document.createElement('td');
    tdName.textContent = r.name || r.symbolicName;
    tdOk.textContent = fmt(r.completed||0);
    tdFail.textContent = fmt(r.failed||0);
    tdOk.className = 'counts ok';
    tdFail.className = 'counts fail';
    tr.appendChild(tdName);
    tr.appendChild(tdOk);
    tr.appendChild(tdFail);
    container.appendChild(tr);
  }
}

(async function init(){
  const status = document.getElementById('status');
  status.textContent = 'Loading from current tenant...';
  try{
    const resp = await sendToActiveTab({ type: 'CPI_LITE_LOAD' });
    if (!resp || !resp.ok){
      throw new Error(resp && resp.error || 'Unknown error');
    }
    render(resp.data || []);
    status.textContent = `Loaded ${resp.data.length} iFlows.`;
  }catch(e){
    status.textContent = 'Failed to load data. Open a CPI tab and try again.';
    console.error(e);
  }
})();
