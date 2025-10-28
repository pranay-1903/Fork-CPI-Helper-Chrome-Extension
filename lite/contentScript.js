/* CPI Helper Lite content script */
(function(){
  const state = {
    urlExtension: "",
    tenant: location.host,
    runtimeLocations: [],
    currentPlatform: /cfapps/.test(location.host) ? "cf" : "neo",
  };

  function absolutePath(href){
    const a = document.createElement('a');
    a.href = href;
    return a.protocol + '//' + a.host + a.pathname + a.search + a.hash;
  }

  // detect classic itspaces prefix for NEO
  function computeUrlExtension(){
    const isCF = /integrationsuite(-trial)?/.test(location.host);
    return isCF ? "" : "itspaces/";
  }

  async function http(method, url, accept){
    return new Promise((resolve, reject)=>{
      const xhr = new XMLHttpRequest();
      xhr.withCredentials = true;
      xhr.open(method, absolutePath(url));
      if (accept) xhr.setRequestHeader('Accept', accept);
      xhr.onload = ()=>{
        if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.responseText);
        reject(new Error(method+" "+url+" status "+xhr.status));
      };
      xhr.onerror = ()=>reject(new Error("network error"));
      xhr.send();
    });
  }

  async function listAllIflowsCF(){
    // 1) Runtime locations
    const runtimeXml = await http('GET', '/'+state.urlExtension+'Operations/com.sap.it.op.srv.web.cf.RuntimeLocationListCommand');
    const runtimeJson = new XmlToJson().parse(runtimeXml)['com.sap.it.op.srv.web.cf.RuntimeLocationListResponse'];
    const locations = Array.isArray(runtimeJson.runtimeLocations) ? runtimeJson.runtimeLocations : [runtimeJson.runtimeLocations];
    state.runtimeLocations = locations.filter(l=>String(l.state).toUpperCase()==='ACTIVE');

    // 2) For each location, list Integration Components and aggregate artifacts
    const seen = new Map();
    for (const loc of state.runtimeLocations){
      const respXml = await http('GET', '/'+state.urlExtension+'Operations/com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentsListCommand?runtimeLocationId='+encodeURIComponent(loc.id));
      const parsed = new XmlToJson().parse(respXml)['com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentsListResponse'];
      const list = Array.isArray(parsed.artifactInformations) ? parsed.artifactInformations : (parsed.artifactInformations ? [parsed.artifactInformations] : []);
      for (const a of list){
        if (!a || !a.symbolicName) continue;
        if (!seen.has(a.symbolicName)){
          seen.set(a.symbolicName, { id: a.id, name: a.name, symbolicName: a.symbolicName });
        }
      }
    }
    return Array.from(seen.values());
  }

  async function listAllIflowsNEO(){
    const respXml = await http('GET', '/'+state.urlExtension+'Operations/com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentsListCommand');
    const parsed = new XmlToJson().parse(respXml)['com.sap.it.op.tmn.commands.dashboard.webui.IntegrationComponentsListResponse'];
    const list = Array.isArray(parsed.artifactInformations) ? parsed.artifactInformations : (parsed.artifactInformations ? [parsed.artifactInformations] : []);
    return list.map(a=>({ id: a.id, name: a.name, symbolicName: a.symbolicName }));
  }

  async function getCountsForIflow(symbolicName){
    // Count across all available logs
    const to = new Date();
    const from = new Date(to.getTime() - 24*60*60*1000); // kept for potential future narrowing
    const iso = d=>new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().replace('Z','');
    const baseCount = '/'+state.urlExtension+"odata/api/v1/MessageProcessingLogs/$count";
    const common = ` and Status ne 'DISCARDED'`;

    // Escape single quotes for OData literal and URL-encode the entire $filter expression
    const esc = (s)=>String(s).replace(/'/g, "''");
    const filterCompleted = `IntegrationFlowName eq '${esc(symbolicName)}' and Status eq 'COMPLETED'${common}`;
    const filterFailed    = `IntegrationFlowName eq '${esc(symbolicName)}' and Status eq 'FAILED'${common}`;

    const qCompleted = `${baseCount}?$filter=${encodeURIComponent(filterCompleted)}`;
    const qFailed    = `${baseCount}?$filter=${encodeURIComponent(filterFailed)}`;

    const completed = parseInt(await http('GET', qCompleted, 'text/plain'), 10) || 0;
    const failed    = parseInt(await http('GET', qFailed, 'text/plain'), 10) || 0;
    return { completed, failed };
  }

  async function collect(){
    state.urlExtension = computeUrlExtension();
    const iflows = state.currentPlatform === 'cf' ? await listAllIflowsCF() : await listAllIflowsNEO();
    // Parallel counts with small concurrency to avoid hammering
    const results = [];
    const batchSize = 6;
    for (let i=0;i<iflows.length;i+=batchSize){
      const slice = iflows.slice(i,i+batchSize);
      const part = await Promise.all(slice.map(async f=>({
        name: f.name || f.symbolicName,
        symbolicName: f.symbolicName,
        ...(await getCountsForIflow(f.symbolicName))
      })));
      results.push(...part);
    }
    return results;
  }

  // Handle requests from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
    if (msg && msg.type === 'CPI_LITE_LOAD'){
      (async ()=>{
        try{
          const data = await collect();
          sendResponse({ ok:true, data });
        }catch(e){
          sendResponse({ ok:false, error: String(e && e.message || e) });
        }
      })();
      return true; // async response
    }
  });
})();
