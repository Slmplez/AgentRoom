// Called only by the unified client/transport, after the host has established its session.
export function createFileReviewTransport({fetch:fetcher=globalThis.fetch,baseUrl='',headers=()=>({})}={}) {
 return async input=>{
  let response;
  try{response=await fetcher(`${baseUrl}/api/v1/file-review`,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json',...headers()},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});}catch{throw Object.assign(Error('连接中断，草稿已保留，请核查并重试。'),{code:'offline',outcome:input.type==='saveFile'||input.type==='addComment'?'unknown':'rejected'});}
  const result=await response.json();if(!response.ok||result.ok!==true)throw Object.assign(Error(result.error?.message||'文件服务不可用。'),{code:result.error?.code||'unavailable',outcome:result.error?.outcome||'unknown'});return result.value;
 };
}
