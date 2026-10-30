// Bounded untrusted JSON with no duplicate/object-prototype keys. JSON.parse
// validates syntax first; the scan retains keys that JSON.parse would discard.
export function parseReportJson(text) {
  const value=JSON.parse(text); let i=0;
  const space=()=>{while(/\s/.test(text[i]||'x')) i++;};
  function string() { const start=i++; while(i<text.length) { if(text[i]==='\\') i+=2; else if(text[i++]==='"') return JSON.parse(text.slice(start,i)); } throw Error('Invalid string'); }
  function scan(depth=0) {
    if(depth>20) throw Error('JSON nesting limit'); space();
    if(text[i]==='"') {string();return;}
    if(text[i]==='{') {
      i++;space();const keys=new Set(); if(text[i]==='}') {i++;return;}
      while(i<text.length) {space();const key=string(); if(keys.has(key)||['__proto__','constructor','prototype'].includes(key)) throw Error('Duplicate or unsafe key'); keys.add(key);space();i++;scan(depth+1);space();if(text[i++]==='}')return;}
    } else if(text[i]==='[') {
      i++;space();if(text[i]===']'){i++;return;}
      while(i<text.length){scan(depth+1);space();if(text[i++]===']')return;}
    } else {while(i<text.length&&!/[\s,}\]]/.test(text[i]))i++;}
  }
  scan();return value;
}
