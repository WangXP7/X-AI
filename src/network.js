// Fetch cannot distinguish DNS, offline and CORS errors. Keep the operation explicit.
export class ConnectionError extends Error{
  constructor(operation,connection,error){
    const timeout=['TimeoutError','AbortError'].includes(error?.name);
    const label={submit:'提交任务',poll:'查询原任务',models:'检查 API 连接',media:'下载视频'}[operation]||'网络请求';
    const reason=timeout?'请求超时':error?.status===403&&connection==='bridge'?'本机配对码或页面来源不匹配':error?.status?'接口返回 '+error.status:connection==='bridge'?'无法连接本机连接器':connection==='local'?'本机下载服务不可用，请重新启动 X-AI':'浏览器未能读取响应（网络或跨域问题）';
    super(label+'失败：'+reason+'。'+(operation==='media'?'服务端已生成，原视频地址保留；请重试下载、使用本机连接器或下载后导入。':operation==='submit'?'提交结果可能不明，先核实原任务，不能重复提交。':'已有任务编号保留，请修复连接后继续查询。'));
    this.name='ConnectionError';this.operation=operation;this.connection=connection;this.code=timeout?'timeout':error?.status?'http_'+error.status:'fetch_unreadable';
  }
}
export function networkRecord(error){return error instanceof ConnectionError?{at:new Date().toISOString(),operation:error.operation,connection:error.connection,code:error.code,message:error.message}:null;}
export function taskProblem(job){
  const a=job.attempts?.at(-1),status=String(a?.pollResponse?.status||'').toLowerCase(),completed=!!a?.url||['completed','success','succeeded'].includes(status);
  if(job.state==='blocked'&&completed&&!job.current){
    const operation=a?.lastProblem?.operation;
    const local=!!a?.rawBlobKey||!!a?.rawPath;
    return {label:local?'已生成 · 本地校验待恢复':'已生成 · 下载待恢复',stage:local?4:3,
      message:operation?job.error:local?'服务端已生成，原文件已保存；本地校验或保存未完成，请恢复原文件处理。':'服务端已生成，但网页下载未完成；原地址保留，可重试下载或下载后导入。',
      remoteCompleted:true,downloadPending:!local};
  }
  return {label:null,stage:null,message:job.error||'',remoteCompleted:completed,downloadPending:false};
}
