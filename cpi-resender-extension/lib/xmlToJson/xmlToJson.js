// Minimal placeholder: copy of existing lib is assumed available in main repo.
// For this prototype, include a tiny wrapper that expects XML strings from CPI Operations endpoints and returns a naive object.
// You should replace this with the full xmlToJson used in the original project for robustness.
(function(){
  function XmlToJson(){}
  XmlToJson.prototype.parse = function(xmlString){
    try{
      var parser = new DOMParser();
      var xml = parser.parseFromString(xmlString, 'application/xml');
      function nodeToObj(node){
        var obj = {};
        if(node.nodeType === 1){
          // element
          if(node.attributes && node.attributes.length){
            obj['@attrs'] = {};
            Array.from(node.attributes).forEach(a=>{ obj['@attrs'][a.name]=a.value; });
          }
        }
        // children
        if(node.childNodes && node.childNodes.length){
          Array.from(node.childNodes).forEach(ch=>{
            if(ch.nodeType === 3){
              var t = ch.nodeValue.trim();
              if(t){ obj['#text'] = (obj['#text']||'') + t; }
            } else if (ch.nodeType === 1){
              var name = ch.nodeName;
              var v = nodeToObj(ch);
              if(obj[name]){
                if(!Array.isArray(obj[name])) obj[name] = [obj[name]];
                obj[name].push(v);
              } else {
                obj[name] = v;
              }
            }
          });
        }
        return obj;
      }
      var root = xml.documentElement;
      var out = {};
      out[root.nodeName] = nodeToObj(root);
      return out;
    }catch(e){
      return {};
    }
  }
  if(typeof window !== 'undefined') window.XmlToJson = XmlToJson;
})();
