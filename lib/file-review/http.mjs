// Mount behind the existing authenticated host. This handler never grants identity itself.
export function createFileReviewHandler({ service, authenticate }) {
 return async (req,res) => {
  if(new URL(req.url,'http://localhost').pathname!=='/api/v1/file-review')return false;
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try {
   const caller=await authenticate(req);
   if(!caller)throw Object.assign(Error('请先登录本机会话。'),{code:'unauthorized'});
   if(req.method!=='POST'||!String(req.headers['content-type']).startsWith('application/json'))throw Object.assign(Error('请求格式无效。'),{code:'invalid_request'});
   let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw Object.assign(Error('请求过大。'),{code:'request_too_large'});chunks.push(chunk);}
   const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   const value=await service.request(input,caller);
   res.end(JSON.stringify({ok:true,value}));
  }catch(e){res.statusCode=e.code==='unauthorized'?401:e.code==='file_conflict'?409:400;res.end(JSON.stringify({ok:false,error:{code:e.code||'invalid_request',message:e.code?e.message:'请求格式不正确。',outcome:e.outcome||'rejected'}}));}
  return true;
 };
}
