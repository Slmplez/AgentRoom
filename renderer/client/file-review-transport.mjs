// Called only by the unified client/transport, after the host has established its session.
export function createFileReviewTransport({fetch:fetcher=globalThis.fetch,baseUrl='',headers=()=>({}),signal}={}) {
 return async input=>{
  let response;
  const outcome=input.type==='saveFile'||input.type==='addComment'?'unknown':'rejected';
  try{response=await fetcher(`${baseUrl}/api/v1/file-review`,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'Content-Type':'application/json',...headers()},body:JSON.stringify(input),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});}catch{throw Object.assign(Error('连接中断，草稿已保留，请核查并重试。'),{code:'offline',outcome});}
  let result;try{result=await response.json();}catch{throw Object.assign(Error('文件服务响应未完成，请核查原请求。'),{code:'invalid_response',outcome});}
  if(!response.ok||result.ok!==true){const error=result.error||result;throw Object.assign(Error(error.message||'文件服务不可用。'),{code:error.code||'unavailable',outcome:error.outcome||outcome});}return result.value;
 };
}
