// Transport-only bounded receiver. Authentication and room authorization happen first.
function createAttachmentReceiver() {
  let receiving = 0;
  return async function receive(req) {
    const reject = (code, message, status) => Object.assign(new Error(message), {code,message,status,outcome:'rejected'});
    if ((req.headers['content-type'] || '').toLowerCase() !== 'application/octet-stream') throw reject('invalid_request','附件需要二进制请求。',415);
    if (receiving >= 2) throw reject('busy','已有两个附件正在上传，请稍后明确重试。',429);
    const limit=8*1024*1024;
    if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > limit)) throw reject('too_large','单个附件不能超过 8 MiB。',413);
    receiving++;
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;req.destroy();},15000);
    try {
      const chunks=[]; let size=0;
      for await (const chunk of req.iterator({destroyOnReturn:false})) {
        size+=chunk.length;
        if(size>limit) { req.resume(); throw reject('too_large','单个附件不能超过 8 MiB。',413); }
        chunks.push(chunk);
      }
      if(!size) throw reject('invalid_attachment','附件不能为空。',400);
      return Buffer.concat(chunks,size);
    } catch(e) { if(timedOut) throw reject('upload_timeout','附件上传超时，请核查后重试。',408); throw e; }
    finally {clearTimeout(timer);receiving--;}
  };
}
module.exports={createAttachmentReceiver};
